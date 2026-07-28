import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  SchemaType,
} from '@google/generative-ai';
import { PrismaService } from '../prisma/prisma.service';
import {
  GITHUB_SCORE_WEIGHT,
  INTERVIEW_SCORE_WEIGHT,
} from './config/scoring.config';
import type {
  InterviewAnalysis,
  TranscriptEntry,
} from './dto/interview-events.dto';
import type { RepoSignals } from '../github-sync/github-sync.service';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Baseline questions asked every time, in order, one per turn */
const BASELINE_QUESTIONS = [
  'Tell me about a few projects you have worked on recently.',
  'Of those projects, which ones did you actually finish and ship? What happened to the others?',
  'When a project gets difficult or you hit a blocker, what do you typically do?',
  'How do you usually communicate with teammates during a project — how often, and on what channels?',
  'On average, how many hours a day can you realistically commit to a hackathon or short-term project?',
];

const GEMINI_MODEL = 'gemini-3.6-flash';

/** Safety settings — neutral for professional context */
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/** JSON schema enforced by Gemini responseSchema (controlled generation) */
const ANALYSIS_RESPONSE_SCHEMA: import('@google/generative-ai').ObjectSchema = {
  type: SchemaType.OBJECT as const,
  properties: {
    specificity_score: {
      type: SchemaType.NUMBER,
      description: 'Overall specificity and concreteness of answers, 0–100',
    },
    declared_hours_per_day: {
      type: SchemaType.NUMBER,
      description: 'Hours per day the user declared they can commit',
    },
    flagged_discrepancies: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          repo:             { type: SchemaType.STRING },
          issue:            { type: SchemaType.STRING },
          user_explanation: { type: SchemaType.STRING },
        },
        required: ['repo', 'issue', 'user_explanation'],
      },
    },
    communication_style_notes: {
      type: SchemaType.STRING,
      description: 'Neutral notes on how the user described their communication habits',
    },
  },
  required: [
    'specificity_score',
    'declared_hours_per_day',
    'flagged_discrepancies',
    'communication_style_notes',
  ],
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);
  private readonly genAI: GoogleGenerativeAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment');
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  // ── Public: start a new interview ─────────────────────────────────────────

  /**
   * Validates preconditions, creates/resets the interview_sessions row,
   * and streams the first baseline question back via the provided callback.
   *
   * @param userId     The user whose interview is starting
   * @param onChunk    Called with each raw text chunk as it streams
   * @param onComplete Called with the full assembled message when streaming ends
   * @returns          The new sessionId
   */
  async startInterview(
    userId: string,
    onChunk: (chunk: string, sessionId: string) => void,
    onComplete: (fullText: string, turnIndex: number, sessionId: string) => void,
  ): Promise<string> {
    // ── 1. Precondition: github_metrics must be complete ──────────────────
    const metrics = await this.prisma.githubMetrics.findUnique({
      where: { userId },
    });

    if (!metrics || metrics.status !== 'complete') {
      throw new Error(
        'GitHub metrics are not yet complete. Cannot start interview.',
      );
    }

    // ── 2. Create / reset interview session ───────────────────────────────
    const session = await this.prisma.interviewSession.upsert({
      where: { userId },
      create: {
        userId,
        status: 'in_progress',
        transcriptJson: [],
      },
      update: {
        status: 'in_progress',
        transcriptJson: [],
        structuredOutput: undefined,
        errorReason: null,
      },
    });

    this.logger.log(`Interview session ${session.id} started for user ${userId}`);

    // ── 3. Build system prompt with GitHub metrics context ────────────────
    const repoBreakdown = (metrics.repoBreakdown ?? []) as unknown as RepoSignals[];
    const systemPrompt = this.buildSystemPrompt(repoBreakdown);

    // ── 4. Stream the first baseline question ─────────────────────────────
    const firstQuestion = BASELINE_QUESTIONS[0];
    await this.streamGeminiTurn(
      session.id,
      userId,
      systemPrompt,
      [],            // empty history — first turn
      firstQuestion, // The AI asks this question to the user (we inject it)
      (chunk) => onChunk(chunk, session.id),
      (fullText, turnIndex) => onComplete(fullText, turnIndex, session.id),
      0,             // turnIndex
    );

    return session.id;
  }

  // ── Public: handle a user answer ─────────────────────────────────────────

  /**
   * Appends the user's answer to the transcript, persists immediately,
   * then streams the next AI question/follow-up.
   *
   * @returns true if the interview should continue, false if it's complete
   */
  async continueInterview(
    userId: string,
    sessionId: string,
    userAnswer: string,
    onChunk: (chunk: string, sessionId: string) => void,
    onComplete: (fullText: string, turnIndex: number, sessionId: string) => void,
  ): Promise<boolean> {
    // ── 1. Load current session ───────────────────────────────────────────
    const session = await this.prisma.interviewSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.status !== 'in_progress') {
      throw new Error(`Session ${sessionId} is not active`);
    }

    const transcript = (session.transcriptJson as unknown as TranscriptEntry[]) ?? [];

    // ── 2. Determine current turn index (number of completed AI turns so far)
    const completedAiTurns = transcript.filter((t) => t.role === 'assistant').length;
    const nextTurnIndex = completedAiTurns; // 0-based index of the AI's next response

    // ── 3. Append user answer + persist immediately ───────────────────────
    const updatedTranscript: TranscriptEntry[] = [
      ...transcript,
      { role: 'user', content: userAnswer, timestamp: new Date().toISOString() },
    ];

    await this.prisma.interviewSession.update({
      where: { id: sessionId },
      data: { transcriptJson: updatedTranscript as any },
    });

    // ── 4. Decide: baseline question or AI-generated follow-up ────────────
    const hasMoreBaseline = completedAiTurns < BASELINE_QUESTIONS.length;

    const metrics = await this.prisma.githubMetrics.findUnique({ where: { userId } });
    const repoBreakdown = (metrics?.repoBreakdown ?? []) as unknown as RepoSignals[];
    const systemPrompt = this.buildSystemPrompt(repoBreakdown);

    let fullResponse = '';

    if (hasMoreBaseline) {
      // Inject the next baseline question directly
      const nextQuestion = BASELINE_QUESTIONS[completedAiTurns];
      fullResponse = nextQuestion;

      // Persist the AI's baseline question to transcript
      const withAiTurn: TranscriptEntry[] = [
        ...updatedTranscript,
        { role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() },
      ];
      await this.prisma.interviewSession.update({
        where: { id: sessionId },
        data: { transcriptJson: withAiTurn as any },
      });

      // Emit as if it streamed (send full text as one chunk, then complete)
      onChunk(fullResponse, sessionId);
      onComplete(fullResponse, nextTurnIndex, sessionId);
      return true; // interview continues
    } else {
      // All baseline questions answered — let Gemini generate a follow-up or signal completion
      fullResponse = await this.streamGeminiTurn(
        sessionId,
        userId,
        systemPrompt,
        updatedTranscript,
        null, // no injected question — let Gemini decide
        (chunk) => onChunk(chunk, sessionId),
        (fullText, turnIndex) => onComplete(fullText, turnIndex, sessionId),
        nextTurnIndex,
      );

      // Check if Gemini signalled completion
      return !fullResponse.includes('[INTERVIEW_COMPLETE]');
    }
  }

  // ── Public: finalise and produce structured output ────────────────────────

  /**
   * Sends the full transcript to Gemini with responseSchema enforcement,
   * validates the output, writes commitment_scores, marks session complete.
   * Retries once on failure; marks failed on second failure.
   */
  async finaliseInterview(
    userId: string,
    sessionId: string,
    emitComplete: (payload: {
      commitmentScore: number;
      githubScore: number;
      interviewScore: number;
      declaredHoursPerDay: number | null;
      flaggedDiscrepancies: Array<{ repo: string; issue: string; userExplanation: string }>;
      communicationStyleNotes: string;
    }) => void,
    emitError: (reason: string) => void,
  ): Promise<void> {
    const session = await this.prisma.interviewSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return;

    const transcript = (session.transcriptJson as unknown as TranscriptEntry[]) ?? [];

    let analysis: InterviewAnalysis | null = null;
    let lastError = '';

    // ── Retry loop: max 2 attempts ────────────────────────────────────────
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        analysis = await this.runStructuredAnalysis(transcript);
        break; // success
      } catch (err) {
        lastError = (err as Error).message;
        this.logger.warn(`Structured analysis attempt ${attempt} failed: ${lastError}`);
        if (attempt === 2) {
          // Both attempts failed — mark session failed and emit error
          await this.prisma.interviewSession.update({
            where: { id: sessionId },
            data: { status: 'failed', errorReason: lastError },
          });
          emitError(lastError);
          return;
        }
        // Wait 1s before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (!analysis) return;

    // ── Compute commitment score ──────────────────────────────────────────
    const metrics = await this.prisma.githubMetrics.findUnique({ where: { userId } });
    const githubScore = metrics?.githubConsistencyScore ?? 0;
    const interviewScore = analysis.specificity_score;

    const commitmentScore =
      Math.round(
        (githubScore * GITHUB_SCORE_WEIGHT + interviewScore * INTERVIEW_SCORE_WEIGHT) * 100,
      ) / 100;

    // ── Persist structured output + update session status ─────────────────
    await this.prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        status: 'complete',
        structuredOutput: analysis as any,
      },
    });

    // ── Write commitment_scores row ───────────────────────────────────────
    const discrepancies = analysis.flagged_discrepancies.map((d) => ({
      repo: d.repo,
      issue: d.issue,
      userExplanation: d.user_explanation,
    }));

    await this.prisma.commitmentScore.upsert({
      where: { userId },
      create: {
        userId,
        githubScore,
        interviewScore,
        commitmentScore,
        declaredHoursPerDay: analysis.declared_hours_per_day,
        flaggedDiscrepancies: discrepancies as any,
        communicationNotes: analysis.communication_style_notes,
      },
      update: {
        githubScore,
        interviewScore,
        commitmentScore,
        declaredHoursPerDay: analysis.declared_hours_per_day,
        flaggedDiscrepancies: discrepancies as any,
        communicationNotes: analysis.communication_style_notes,
      },
    });

    // ── Also update the denormalised commitmentScore on User ─────────────
    await this.prisma.user.update({
      where: { id: userId },
      data: { commitmentScore },
    });

    this.logger.log(
      `Interview complete for user ${userId} — commitmentScore: ${commitmentScore} ` +
      `(github: ${githubScore} × ${GITHUB_SCORE_WEIGHT} + interview: ${interviewScore} × ${INTERVIEW_SCORE_WEIGHT})`,
    );

    // ── Emit final event to frontend ──────────────────────────────────────
    emitComplete({
      commitmentScore,
      githubScore,
      interviewScore,
      declaredHoursPerDay: analysis.declared_hours_per_day,
      flaggedDiscrepancies: discrepancies,
      communicationStyleNotes: analysis.communication_style_notes,
    });
  }

  // ── Private: stream a single Gemini turn ─────────────────────────────────

  /**
   * Streams one Gemini response turn.
   * - If `injectedQuestion` is provided, it sends that as the AI message (for baseline questions)
   *   and appends it to transcript without calling Gemini.
   * - Otherwise, sends the full transcript as context and asks Gemini for the next message.
   *
   * Returns the full assembled text of the AI's response.
   */
  private async streamGeminiTurn(
    sessionId: string,
    userId: string,
    systemPrompt: string,
    currentTranscript: TranscriptEntry[],
    injectedQuestion: string | null,
    onChunk: (chunk: string) => void,
    onComplete: (fullText: string, turnIndex: number) => void,
    turnIndex: number,
  ): Promise<string> {
    // ── Baseline injected question path ────────────────────────────────────
    if (injectedQuestion) {
      await this.appendToTranscript(sessionId, 'assistant', injectedQuestion);
      onChunk(injectedQuestion);
      onComplete(injectedQuestion, turnIndex);
      return injectedQuestion;
    }

    // ── Gemini streaming path ──────────────────────────────────────────────
    const model = this.genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
      safetySettings: SAFETY_SETTINGS,
    });

    // Gemini history MUST start with role 'user' and alternate.
    const rawHistory = currentTranscript.map((entry) => ({
      role: entry.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: entry.content }],
    }));

    const history =
      rawHistory.length > 0 && rawHistory[0].role === 'model'
        ? [
            {
              role: 'user' as const,
              parts: [{ text: 'Hello, I am ready for the interview.' }],
            },
            ...rawHistory,
          ]
        : rawHistory;

    const chat = model.startChat({ history });

    const userMessage =
      'Continue the interview. Ask your next follow-up question based on the candidate responses so far. If you have gathered sufficient information across all areas (projects, completion, difficulty handling, communication, time commitment) and probed any GitHub discrepancies, respond with exactly [INTERVIEW_COMPLETE] followed by a brief closing statement.';

    let fullText = '';

    try {
      const result = await chat.sendMessageStream(userMessage);

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText) {
          fullText += chunkText;
          onChunk(chunkText);
        }
      }
    } catch (err) {
      throw new Error(`Gemini streaming failed: ${(err as Error).message}`);
    }

    await this.appendToTranscript(sessionId, 'assistant', fullText);
    onComplete(fullText, turnIndex);
    return fullText;
  }

  // ── Private: structured analysis via Gemini responseSchema ───────────────

  private async runStructuredAnalysis(
    transcript: TranscriptEntry[],
  ): Promise<InterviewAnalysis> {
    const model = this.genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      },
      safetySettings: SAFETY_SETTINGS,
    });

    const transcriptText = transcript
      .map((t) => `${t.role === 'assistant' ? 'Interviewer' : 'Candidate'}: ${t.content}`)
      .join('\n\n');

    const prompt = `
You are analysing a commitment interview transcript. Based on the conversation below, produce a structured assessment.

TRANSCRIPT:
${transcriptText}

Produce the JSON output now. Be objective and neutral — flag discrepancies as data points, not accusations.
Specificity score should reflect how concrete and specific the candidate's answers were (vague = low, detailed and verifiable = high).
For flagged_discrepancies, only include items where there is a genuine tension between what was said and what the GitHub data shows.
If no discrepancies exist, return an empty array.
    `.trim();

    const result = await model.generateContent(prompt);
    const raw = result.response.text();

    let parsed: InterviewAnalysis;
    try {
      parsed = JSON.parse(raw) as InterviewAnalysis;
    } catch {
      throw new Error(`Gemini returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    // Basic schema validation
    if (
      typeof parsed.specificity_score !== 'number' ||
      typeof parsed.declared_hours_per_day !== 'number' ||
      !Array.isArray(parsed.flagged_discrepancies) ||
      typeof parsed.communication_style_notes !== 'string'
    ) {
      throw new Error('Gemini structured output did not match expected schema');
    }

    return parsed;
  }

  // ── Private: system prompt builder ───────────────────────────────────────

  private buildSystemPrompt(repos: RepoSignals[]): string {
    const repoSummary = repos
      .map(
        (r) =>
          `  - ${r.name}: commit consistency ${(r.commitGapConsistency * 100).toFixed(0)}%, ` +
          `PR merge rate ${(r.prMergeRatio * 100).toFixed(0)}%, ` +
          `issue close rate ${(r.issueCloseRatio * 100).toFixed(0)}%, ` +
          `completion signal ${(r.completionSignal * 100).toFixed(0)}%, ` +
          `repo score ${r.repoScore}/100`,
      )
      .join('\n');

    return `
You are TruMatch's commitment interviewer. Your role is neutral fact-gathering and consistency-checking — NOT judgment.

RULES:
- Ask one question at a time. Never ask multiple questions in a single turn.
- Be conversational and warm, not clinical or interrogative.
- Never accuse the user of lying. If something doesn't add up, flag it as a data point: "I noticed X in your GitHub data — can you tell me more about that?"
- Ground any follow-up questions in the ACTUAL GitHub data below. Do not invent data or ask generic questions unrelated to the user's real repos.
- Reference repos by their actual names when asking follow-up questions.
- When you have covered all baseline areas and any significant discrepancies, emit [INTERVIEW_COMPLETE] to signal the interview is done.

GITHUB DATA FOR THIS USER:
${repoSummary.length > 0 ? repoSummary : '  (No qualifying repositories found)'}

WHAT TO PROBE:
- Projects worked on (match against actual repo names)
- Projects finished vs abandoned (compare against completion signals and commit drop-offs)
- How they handle difficulty (look for repos with low completion signal)
- Communication with teammates (no direct GitHub metric, ask openly)
- Hours per day available (declared_hours_per_day — capture this precisely)
- Any repos with very low PR merge rate or issue close rate — ask why without assuming the worst
    `.trim();
  }

  // ── Private: append a single entry to a session's transcript ─────────────

  private async appendToTranscript(
    sessionId: string,
    role: 'assistant' | 'user',
    content: string,
  ): Promise<void> {
    const session = await this.prisma.interviewSession.findUnique({
      where: { id: sessionId },
      select: { transcriptJson: true },
    });

    const existing = (session?.transcriptJson as unknown as TranscriptEntry[]) ?? [];
    const updated: TranscriptEntry[] = [
      ...existing,
      { role, content, timestamp: new Date().toISOString() },
    ];

    await this.prisma.interviewSession.update({
      where: { id: sessionId },
      data: { transcriptJson: updated as any },
    });
  }
}

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { InterviewService } from './interview.service';
import type {
  InterviewStartPayload,
  InterviewAnswerPayload,
  InterviewCompletePayload,
  InterviewChunkEvent,
  InterviewMessageCompleteEvent,
  InterviewCompleteEvent,
  InterviewErrorEvent,
  InterviewStartResponseEvent,
} from './dto/interview-events.dto';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/interview',
})
export class InterviewGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InterviewGateway.name);

  constructor(private readonly interviewService: InterviewService) {}

  handleConnection(client: Socket) {
    this.logger.debug(`[interview] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`[interview] Client disconnected: ${client.id}`);
  }

  /**
   * Client emits 'join-room' to subscribe to their user room.
   * Reuses the same per-user room pattern as github-sync.
   */
  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @MessageBody() data: { userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `user:${data.userId}`;
    await client.join(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    return { joined: true };
  }

  /**
   * Client emits 'interview:start'.
   * Server validates preconditions, creates the session, and begins streaming
   * the first question.
   *
   * Now returns the pre-interview warning text in the acknowledgement.
   */
  @SubscribeMessage('interview:start')
  async handleStart(
    @MessageBody() data: InterviewStartPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { userId } = data;
    const room = `user:${userId}`;

    this.logger.log(`interview:start received for user ${userId}`);

    try {
      const { sessionId, preInterviewWarning } = await this.interviewService.startInterview(
        userId,
        (chunk, sId) => {
          const event: InterviewChunkEvent = { sessionId: sId, chunk };
          this.server.to(room).emit('interview:chunk', event);
        },
        (fullText, turnIndex, sId) => {
          const event: InterviewMessageCompleteEvent = {
            sessionId: sId,
            fullText,
            turnIndex,
          };
          this.server.to(room).emit('interview:message-complete', event);
        },
      );

      const response: InterviewStartResponseEvent = {
        sessionId,
        preInterviewWarning,
      };
      return response;
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`interview:start failed for user ${userId}: ${reason}`);
      const event: InterviewErrorEvent = { sessionId: '', reason };
      client.emit('interview:error', event);
    }
  }

  /**
   * Client emits 'interview:answer' with the user's response to the last question.
   * Server appends to transcript, persists, then streams the next question.
   * When the interview is complete (server-driven), calls finaliseInterview().
   */
  @SubscribeMessage('interview:answer')
  async handleAnswer(
    @MessageBody() data: InterviewAnswerPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { userId, sessionId, answer } = data;
    const room = `user:${userId}`;

    this.logger.log(`interview:answer received — session ${sessionId}`);

    try {
      const shouldContinue = await this.interviewService.continueInterview(
        userId,
        sessionId,
        answer,
        (chunk, sId) => {
          const event: InterviewChunkEvent = { sessionId: sId, chunk };
          this.server.to(room).emit('interview:chunk', event);
        },
        (fullText, turnIndex, sId) => {
          const event: InterviewMessageCompleteEvent = {
            sessionId: sId,
            fullText,
            turnIndex,
          };
          this.server.to(room).emit('interview:message-complete', event);
        },
      );

      if (!shouldContinue) {
        // Gemini signalled completion — run finalisation
        this.logger.log(`Interview ${sessionId} complete — running finalisation`);
        await this.interviewService.finaliseInterview(
          userId,
          sessionId,
          (payload) => {
            const event: InterviewCompleteEvent = {
              sessionId,
              ...payload,
            };
            this.server.to(room).emit('interview:complete', event);
          },
          (reason) => {
            const event: InterviewErrorEvent = { sessionId, reason };
            this.server.to(room).emit('interview:error', event);
          },
        );
      }
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`interview:answer failed — session ${sessionId}: ${reason}`);
      const event: InterviewErrorEvent = { sessionId, reason };
      client.emit('interview:error', event);
    }
  }

  /**
   * Client can explicitly emit 'interview:finish' to trigger finalisation early.
   * (Normally finalisation is server-driven via the [INTERVIEW_COMPLETE] marker.)
   */
  @SubscribeMessage('interview:finish')
  async handleFinish(
    @MessageBody() data: InterviewCompletePayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { userId, sessionId } = data;
    const room = `user:${userId}`;

    this.logger.log(`interview:finish received — session ${sessionId}`);

    try {
      await this.interviewService.finaliseInterview(
        userId,
        sessionId,
        (payload) => {
          const event: InterviewCompleteEvent = { sessionId, ...payload };
          this.server.to(room).emit('interview:complete', event);
        },
        (reason) => {
          const event: InterviewErrorEvent = { sessionId, reason };
          this.server.to(room).emit('interview:error', event);
        },
      );
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`interview:finish failed — session ${sessionId}: ${reason}`);
      const event: InterviewErrorEvent = { sessionId, reason };
      client.emit('interview:error', event);
    }
  }
}

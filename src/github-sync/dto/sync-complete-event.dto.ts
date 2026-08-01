export class SyncCompleteEventDto {
  status: 'complete' | 'failed' | 'insufficient_data';
  score?: number;
  error?: string;
  githubConfidence?: 'high' | 'low' | 'insufficient';
  accountCreatedAt?: string;
}

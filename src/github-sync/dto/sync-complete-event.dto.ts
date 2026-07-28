export class SyncCompleteEventDto {
  status: 'complete' | 'failed';
  score?: number;
  error?: string;
}

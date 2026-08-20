export class CreateRatingDto {
  teamId: string;
  rateeId: string;
  deliveredScore: number;     // 1 to 5
  communicationScore: number; // 1 to 5
  wouldWorkAgain: boolean;
  comment?: string;
}

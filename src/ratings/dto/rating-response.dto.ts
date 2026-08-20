export interface AnonymousCommentDto {
  id: string;
  teamId: string;
  comment: string;
  deliveredScore: number;
  communicationScore: number;
  wouldWorkAgain: boolean;
  createdAt: Date;
}

export interface FullRatingDto {
  id: string;
  teamId: string;
  raterId: string;
  rateeId: string;
  deliveredScore: number;
  communicationScore: number;
  wouldWorkAgain: boolean;
  comment: string | null;
  visibleAt: Date | null;
  createdAt: Date;
}

export interface PublicPeerRatingSummaryDto {
  peerRatingScore: number | null;
  distinctTeamsRated: number;
  appliedPeerWeight: number;
  comments: AnonymousCommentDto[];
}

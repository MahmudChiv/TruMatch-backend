export class CreateHackathonDto {
  title: string;
  externalUrl: string;
  logoUrl?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  submissionDeadline?: string;
  venueType?: 'physical' | 'virtual' | 'hybrid';
  locationLabel?: string;
  latitude?: number;
  longitude?: number;
  prizeInfo?: string;
  tags?: string[];
}

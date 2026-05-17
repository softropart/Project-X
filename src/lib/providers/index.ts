export interface ProviderPriceResult {
  provider: string;
  unitPrice: number | null;
  totalCost: number | null;
  availability: number | null;
  moq?: number | null;
  alternateParts?: string[];
  isWinner?: boolean;
  error?: string;
}

export interface ProviderRequest {
  mpn: string;
  quantity: number;
  currency: string;
}

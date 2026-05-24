export interface PriceBreak {
  quantity: number;
  price: number; // In target currency
}

export interface ProviderPriceResult {
  provider: string;
  unitPrice: number | null;
  totalCost: number | null;
  availability: number | null;
  moq?: number | null;
  alternateParts?: string[];
  isWinner?: boolean;
  error?: string;
  priceBreaks?: PriceBreak[];
  description?: string;
  packaging?: string;
}

export interface ProviderRequest {
  mpn: string;
  quantity: number;
  currency: string;
  packagingPreference?: 'Any' | 'Cut Tape' | 'Reel';
}

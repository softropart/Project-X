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

export interface StandardPriceTier {
  Qty: number;
  unit_price: number;
  currency: string;
}

export interface StandardPackagingCategories {
  "Custom Reel / DigiReel": StandardPriceTier[];
  "Cut-Tape": StandardPriceTier[];
  "Top-reel": StandardPriceTier[];
}

export interface StandardDistributorData {
  availability: number;
  packaging: StandardPackagingCategories;
}

export interface StandardProviderResult {
  provider: string;
  categories: StandardPackagingCategories;
  description: string;
  alternateParts: string[];
  availability: number;
}

export interface StandardPartData {
  [mpn: string]: {
    description: string;
    alias_part_numbers: string[];
    pricing_by_distributor: {
      DigiKey: StandardDistributorData;
      Mouser: StandardDistributorData;
      Element14: StandardDistributorData;
    };
  };
}

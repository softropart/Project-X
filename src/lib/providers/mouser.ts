import { ProviderPriceResult, ProviderRequest, PriceBreak } from './index';

const EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  INR: 0.012, // 1 INR = 0.012 USD
  EUR: 1.08,  // 1 EUR = 1.08 USD
  GBP: 1.27   // 1 GBP = 1.27 USD
};

function convertCurrency(amount: number, from: string, to: string): number {
  if (from === to) return amount;
  const fromRate = EXCHANGE_RATES[from] || 1.0;
  const toRate = EXCHANGE_RATES[to] || 1.0;
  return (amount * fromRate) / toRate;
}

function parseAndConvertPrice(priceStr: string, targetCurrency: string): number {
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned) || 0;
  
  let sourceCurrency = 'USD'; // Default for Mouser
  const lower = priceStr.toLowerCase();
  if (lower.includes('₹') || lower.includes('rs') || lower.includes('inr')) {
    sourceCurrency = 'INR';
  } else if (lower.includes('€') || lower.includes('eur')) {
    sourceCurrency = 'EUR';
  } else if (lower.includes('£') || lower.includes('gbp')) {
    sourceCurrency = 'GBP';
  } else if (lower.includes('$') || lower.includes('usd')) {
    sourceCurrency = 'USD';
  }
  
  return convertCurrency(value, sourceCurrency, targetCurrency);
}

export async function fetchMouserPrice({ mpn, quantity, currency, packagingPreference }: ProviderRequest): Promise<ProviderPriceResult> {
  const apiKey = process.env.MOUSER_API_KEY;
  const provider = "Mouser";

  if (!apiKey) {
    console.error(`[${provider}] API credentials missing.`);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: "Credentials missing" };
  }

  console.log(`[${provider}] Fetching part ${mpn} with quantity ${quantity}`);

  try {
    const res = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SearchByKeywordRequest: {
          keyword: mpn,
          records: 5, // Increased to get packaging options
          startingRecord: 0,
          searchOptions: "string",
          searchWithYourSignUpLanguage: "string"
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[${provider}] API returned status ${res.status}: ${errText}`);
      throw new Error(`API returned status: ${res.status}`);
    }

    const data = await res.json();
    
    // Choose product based on packaging preference
    let part = data?.SearchResults?.Parts?.[0];

    if (Array.isArray(data?.SearchResults?.Parts) && data.SearchResults.Parts.length > 1 && packagingPreference && packagingPreference !== 'Any') {
      for (const p of data.SearchResults.Parts) {
        const packagingVal = String(p.Packaging || '').toLowerCase();
        const descVal = String(p.Description || '').toLowerCase();

        const isReel = packagingVal.includes('reel') || packagingVal.includes('tr') || descVal.includes('tape & reel') || descVal.includes('reel');
        const isCutTape = packagingVal.includes('cut tape') || packagingVal.includes('ct') || packagingVal.includes('strip') || packagingVal.includes('bag') || packagingVal.includes('tube') || packagingVal.includes('tray') || packagingVal.includes('bulk');

        if (packagingPreference === 'Reel' && isReel) {
          part = p;
          break;
        } else if (packagingPreference === 'Cut Tape' && isCutTape) {
          part = p;
          break;
        }
      }
    }

    if (!part) {
      console.log(`[${provider}] Part not found`);
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    // Parse availability (robust check to avoid counting backorders)
    let availability = 0;
    const availStr = part.Availability || '';
    if (availStr && !availStr.toLowerCase().includes('on order') && !availStr.toLowerCase().includes('backorder') && !availStr.toLowerCase().includes('out of stock')) {
      const parsedAvail = parseInt(availStr.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsedAvail)) {
        availability = parsedAvail;
      }
    }

    // Parse price breaks and MOQ
    const priceBreaks = part.PriceBreaks || [];
    
    const moqStr = part.Min || 
                    part.MinimumOrderQuantity || 
                    part.MinOrderQuantity || 
                    part.Mult || 
                    (priceBreaks.length > 0 ? priceBreaks[0].Quantity : '1');
    const moq = parseInt(String(moqStr).replace(/[^0-9]/g, ''), 10) || 1;

    const evalQty = Math.max(quantity, moq);

    let unitPrice = 0;
    const sortedBreaks = [...priceBreaks].sort((a, b) => (a.Quantity || 0) - (b.Quantity || 0));
    for (const pb of sortedBreaks) {
      const breakQty = pb.Quantity || 0;
      const price = parseAndConvertPrice(pb.Price || '', currency);
      if (breakQty <= evalQty && price > 0) {
        unitPrice = price;
      }
    }

    if (unitPrice === 0 && sortedBreaks.length > 0) {
      unitPrice = parseAndConvertPrice(sortedBreaks[0].Price || '', currency);
    }

    // Map all price breaks
    const mappedBreaks: PriceBreak[] = priceBreaks.map((pb: any) => ({
      quantity: pb.Quantity || 0,
      price: parseAndConvertPrice(pb.Price || '', currency)
    })).filter((b: any) => b.quantity > 0 && b.price > 0);

    const alternateParts: string[] = [];
    if (Array.isArray(part.AlternatePackagings)) {
      part.AlternatePackagings.forEach((ap: any) => {
        if (ap.APMfrPN) alternateParts.push(ap.APMfrPN);
      });
    }

    const description = part.Description || "";
    const packaging = part.Packaging || "";

    return {
      provider,
      unitPrice,
      totalCost: parseFloat((unitPrice * evalQty).toFixed(3)),
      availability,
      moq,
      alternateParts,
      priceBreaks: mappedBreaks,
      description,
      packaging,
    };
  } catch (e: any) {
    console.error(`[${provider}] Error fetching part ${mpn}:`, e.message || e);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: e.message || "API Error" };
  }
}

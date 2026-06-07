'use server';

import { fetchDigiKeyPrice, fetchDigiKeyStandardized } from '@/lib/providers/digikey';
import { fetchMouserPrice, fetchMouserStandardized } from '@/lib/providers/mouser';
import { fetchElement14Price, fetchElement14Standardized } from '@/lib/providers/element14';
import { ProviderPriceResult, StandardPartData, StandardPackagingCategories } from '@/lib/providers';

export interface BestPriceResult {
  mpn: string;
  results: ProviderPriceResult[];
  winner: string | null;
  lowestCost: number | null;
  moqUpdated?: boolean;
  originalQty?: number;
  newQty?: number;
  moqRatio?: number;
  alternatives?: BestPriceResult[];
  description?: string;
  packaging?: string;
}

export async function fetchBestPrices(
  mpn: string,
  quantity: number,
  currency: string = 'INR',
  packagingPreference: 'Any' | 'Cut Tape' | 'Reel' = 'Any',
  isAltSearch: boolean = false
): Promise<BestPriceResult> {
  const request = { mpn, quantity, currency, packagingPreference };

  // Fetch from all providers concurrently
  const promises = [
    fetchDigiKeyPrice(request),
    fetchMouserPrice(request),
    fetchElement14Price(request)
  ];

  const settled = await Promise.allSettled(promises);

  const results: ProviderPriceResult[] = [];

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const res = outcome.value;
      results.push(res);
    } else {
      console.error("Provider fetch failed", outcome.reason);
      results.push({
        provider: "Unknown",
        unitPrice: null,
        totalCost: null,
        availability: null,
        error: outcome.reason?.message || "Internal Error"
      });
    }
  }

  // Determine the winner (lowest totalCost that has sufficient availability)
  let lowestCost: number | null = null;
  let winnerIndex = -1;

  results.forEach((res, index) => {
    if (res.totalCost !== null && !res.error && res.availability !== null && res.availability > 0) {
      if (lowestCost === null || res.totalCost < lowestCost) {
        lowestCost = res.totalCost;
        winnerIndex = index;
      }
    }
  });

  let moqRatio = 1;
  let newQty = quantity;
  let moqUpdated = false;

  if (winnerIndex !== -1) {
    results[winnerIndex].isWinner = true;
    const winner = results[winnerIndex];
    if (winner.moq && winner.moq > quantity) {
      moqRatio = winner.moq / quantity;
      newQty = winner.moq;
      moqUpdated = true;
    }
  }

  let description = "";
  let packaging = "";
  results.forEach(res => {
    if (res.description && !description) {
      description = res.description;
    }
    if (res.packaging && !packaging) {
      packaging = res.packaging;
    }
  });

  // Console log the complete results structure for debugging
  console.log(`[fetchBestPrices] MPN: ${mpn}`);
  console.log('[fetchBestPrices] Complete results structure:', JSON.stringify(results, null, 2));
  console.log('[fetchBestPrices] Description type:', typeof description, 'Value:', description);
  console.log('[fetchBestPrices] Packaging:', packaging);

  // Fetch and log standardized part data structure
  try {
    const standardizedData = await fetchStandardizedPartData(mpn, currency);
    console.log('[fetchBestPrices] ========== STANDARDIZED PART DATA ==========');
    console.log(JSON.stringify(standardizedData, null, 2));
    console.log('[fetchBestPrices] ===============================================');
  } catch (err) {
    console.error('[fetchBestPrices] Failed to fetch standardized data:', err);
  }

  let alternatives: BestPriceResult[] = [];

  // Fetch alternatives if we are not already doing an alt search
  if (!isAltSearch) {
    const altMpns = new Set<string>();
    results.forEach(r => {
      r.alternateParts?.forEach(alt => {
        if (alt && alt !== mpn) {
          altMpns.add(alt);
        }
      });
    });

    if (altMpns.size > 0) {
      const altPromises = Array.from(altMpns).slice(0, 3).map(altMpn =>
        fetchBestPrices(altMpn, quantity, currency, packagingPreference, true)
      );
      alternatives = await Promise.all(altPromises);
      // Filter out alternates that completely failed
      alternatives = alternatives.filter(a => a.winner !== null);
    }
  }

  return {
    mpn,
    results,
    winner: winnerIndex !== -1 ? results[winnerIndex].provider : null,
    lowestCost,
    moqUpdated,
    originalQty: quantity,
    newQty,
    moqRatio,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
    description,
    packaging
  };
}

export async function fetchStandardizedPartData(mpn: string, currency: string = 'INR'): Promise<StandardPartData> {
  console.log(`[fetchStandardizedPartData] ========== Starting fetch for ${mpn} ==========`);
  
  const emptyCategories: StandardPackagingCategories = {
    "Custom Reel / DigiReel": [],
    "Cut-Tape": [],
    "Top-reel": []
  };

  // Initialize the base structure
  const result: StandardPartData = {
    [mpn]: {
      description: "",
      alias_part_numbers: [],
      pricing_by_distributor: {
        DigiKey: {
          availability: 0,
          packaging: emptyCategories
        },
        Mouser: {
          availability: 0,
          packaging: emptyCategories
        },
        Element14: {
          availability: 0,
          packaging: emptyCategories
        }
      }
    }
  };

  console.log('[fetchStandardizedPartData] Initial structure:', JSON.stringify(result, null, 2));

  const safeStr = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    return val.ProductDescription || val.DetailedDescription || val.Description || String(val);
  };

  const aliasSet = new Set<string>();

  // Fetch DigiKey
  try {
    console.log('[fetchStandardizedPartData] Calling DigiKey API...');
    const digiKeyRes = await fetchDigiKeyStandardized(mpn, currency);
    
    if (!result[mpn].description) {
      result[mpn].description = safeStr(digiKeyRes.description);
    }
    digiKeyRes.alternateParts.forEach(p => aliasSet.add(p));
    result[mpn].alias_part_numbers = Array.from(aliasSet);
    result[mpn].pricing_by_distributor.DigiKey = {
      availability: digiKeyRes.availability || 0,
      packaging: digiKeyRes.categories || emptyCategories
    };
    
    console.log('[fetchStandardizedPartData] ✅ DigiKey updated:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('[fetchStandardizedPartData] ❌ DigiKey failed:', err.message || err);
    console.log('[fetchStandardizedPartData] Structure after DigiKey failure:', JSON.stringify(result, null, 2));
  }

  // Fetch Mouser
  try {
    console.log('[fetchStandardizedPartData] Calling Mouser API...');
    const mouserRes = await fetchMouserStandardized(mpn, currency);
    
    if (!result[mpn].description) {
      result[mpn].description = safeStr(mouserRes.description);
    }
    mouserRes.alternateParts.forEach(p => aliasSet.add(p));
    result[mpn].alias_part_numbers = Array.from(aliasSet);
    result[mpn].pricing_by_distributor.Mouser = {
      availability: mouserRes.availability || 0,
      packaging: mouserRes.categories || emptyCategories
    };
    
    console.log('[fetchStandardizedPartData] ✅ Mouser updated:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('[fetchStandardizedPartData] ❌ Mouser failed:', err.message || err);
    console.log('[fetchStandardizedPartData] Structure after Mouser failure:', JSON.stringify(result, null, 2));
  }

  // Fetch Element14
  try {
    console.log('[fetchStandardizedPartData] Calling Element14 API...');
    const element14Res = await fetchElement14Standardized(mpn, currency);
    
    if (!result[mpn].description) {
      result[mpn].description = safeStr(element14Res.description);
    }
    element14Res.alternateParts.forEach(p => aliasSet.add(p));
    result[mpn].alias_part_numbers = Array.from(aliasSet);
    result[mpn].pricing_by_distributor.Element14 = {
      availability: element14Res.availability || 0,
      packaging: element14Res.categories || emptyCategories
    };
    
    console.log('[fetchStandardizedPartData] ✅ Element14 updated:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('[fetchStandardizedPartData] ❌ Element14 failed:', err.message || err);
    console.log('[fetchStandardizedPartData] Structure after Element14 failure:', JSON.stringify(result, null, 2));
  }

  console.log('[fetchStandardizedPartData] ========== FINAL STRUCTURE ==========');
  console.log(JSON.stringify(result, null, 2));
  console.log('[fetchStandardizedPartData] ====================================');

  return result;
}

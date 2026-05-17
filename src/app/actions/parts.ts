'use server';

import { fetchDigiKeyPrice } from '@/lib/providers/digikey';
import { fetchMouserPrice } from '@/lib/providers/mouser';
import { fetchElement14Price } from '@/lib/providers/element14';
import { ProviderPriceResult } from '@/lib/providers';

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
}

export async function fetchBestPrices(mpn: string, quantity: number, currency: string = 'INR', isAltSearch: boolean = false): Promise<BestPriceResult> {
  const request = { mpn, quantity, currency };
  
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
        fetchBestPrices(altMpn, quantity, currency, true)
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
    alternatives: alternatives.length > 0 ? alternatives : undefined
  };
}

import { ProviderPriceResult, ProviderRequest } from './index';

export async function fetchMouserPrice({ mpn, quantity, currency }: ProviderRequest): Promise<ProviderPriceResult> {
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
          records: 1,
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
    console.log(`[${provider}] Response:`, JSON.stringify(data, null, 2));
    
    const part = data?.SearchResults?.Parts?.[0];

    if (!part) {
      console.log(`[${provider}] Part not found`);
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    // Parse availability
    const availabilityStr = part.Availability?.replace(/[^0-9]/g, '') || '0';
    const availability = parseInt(availabilityStr, 10);

    // Parse price breaks to find best price for the requested quantity
    let unitPrice = 0;
    const priceBreaks = part.PriceBreaks || [];
    const moqStr = part.Min || (priceBreaks.length > 0 ? priceBreaks[0].Quantity : '1');
    const moq = parseInt(String(moqStr).replace(/[^0-9]/g, ''), 10) || 1;

    const evalQty = Math.max(quantity, moq);

    const sortedBreaks = [...priceBreaks].sort((a, b) => (a.Quantity || 0) - (b.Quantity || 0));
    for (const pb of sortedBreaks) {
      const breakQty = pb.Quantity || 0;
      const price = parseFloat(pb.Price?.replace(/[^0-9.]/g, '') || '0');
      if (breakQty <= evalQty && price > 0) {
        unitPrice = price;
      }
    }

    if (unitPrice === 0 && sortedBreaks.length > 0) {
      unitPrice = parseFloat(sortedBreaks[0].Price?.replace(/[^0-9.]/g, '') || '0');
    }
    const alternateParts: string[] = [];
    if (Array.isArray(part.AlternatePackagings)) {
      part.AlternatePackagings.forEach((ap: any) => {
        if (ap.APMfrPN) alternateParts.push(ap.APMfrPN);
      });
    }

    return {
      provider,
      unitPrice,
      totalCost: parseFloat((unitPrice * evalQty).toFixed(3)),
      availability,
      moq,
      alternateParts,
    };
  } catch (e: any) {
    console.error(`[${provider}] Error fetching part ${mpn}:`, e.message || e);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: e.message || "API Error" };
  }
}

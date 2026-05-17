import { ProviderPriceResult, ProviderRequest } from './index';

export async function fetchElement14Price({ mpn, quantity, currency }: ProviderRequest): Promise<ProviderPriceResult> {
  const apiKey = process.env.ELEMENT14_API_KEY;
  const provider = "Element14";

  if (!apiKey) {
    console.error(`[${provider}] API credentials missing.`);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: "Credentials missing" };
  }

  try {
    const storeId = currency === 'INR' ? 'in.element14.com' : currency === 'EUR' ? 'uk.farnell.com' : 'www.newark.com';

    // Build URL with proper parameters matching the provided code
    const url = `https://api.element14.com/catalog/products?term=manuPartNum%3A${encodeURIComponent(mpn)}&resultsSettings.offset=0&resultsSettings.responseGroup=large&storeInfo.id=${storeId}&resultsSettings.numberOfResults=1&resultsSettings.refinements.filters=inStock&callInfo.omitXmlSchema=false&callInfo.responseDataFormat=json&callinfo.apiKey=${apiKey}`;

    console.log(`[${provider}] Fetching part ${mpn} from ${storeId}`);

    const res = await fetch(url, { method: 'GET' });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[${provider}] API returned status ${res.status}: ${errText}`);
      throw new Error(`API returned status: ${res.status}`);
    }

    const data = await res.json();
    console.log(`[${provider}] Response:`, JSON.stringify(data, null, 2));

    const numberOfResults = data?.manufacturerPartNumberSearchReturn?.numberOfResults || 0;

    if (numberOfResults === 0) {
      console.log(`[${provider}] Part not found`);
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    const products = data?.manufacturerPartNumberSearchReturn?.products || [];
    const product = products[0];

    if (!product) {
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    console.log(`[${provider}] Product found: ${product.translatedManufacturerPartNumber || product.sku}`);

    // Get availability from stock or inventory
    const availability = product.stock?.level || product.inventoryCode || 0;

    // Parse prices array to find best price for quantity
    let unitPrice = 0;
    const prices = product.prices || [];
    
    console.log(`[${provider}] Price breaks:`, JSON.stringify(prices, null, 2));

    const moq = product.minimumOrderQuantity || (prices.length > 0 ? prices[0].from : 1);
    const evalQty = Math.max(quantity, moq);

    const sortedBreaks = [...prices].sort((a, b) => (a.from || 0) - (b.from || 0));
    for (const p of sortedBreaks) {
      const fromQty = p.from || 0;
      const cost = p.cost || 0;
      if (fromQty <= evalQty && cost > 0) {
        unitPrice = cost;
      }
    }

    // Fallback to first price if no match
    if (unitPrice === 0 && sortedBreaks.length > 0) {
      unitPrice = sortedBreaks[0].cost || 0;
    }

    console.log(`[${provider}] Found: unitPrice=${unitPrice}, availability=${availability}`);

    const alternateParts: string[] = [];
    if (product.rohsSubstitute) {
      alternateParts.push(product.rohsSubstitute);
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

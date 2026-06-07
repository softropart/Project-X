import { ProviderPriceResult, ProviderRequest, PriceBreak, StandardProviderResult, StandardPackagingCategories, StandardPriceTier } from './index';

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

export async function fetchElement14Price({ mpn, quantity, currency, packagingPreference }: ProviderRequest): Promise<ProviderPriceResult> {
  const apiKey = process.env.ELEMENT14_API_KEY;
  const provider = "Element14";

  if (!apiKey) {
    console.error(`[${provider}] API credentials missing.`);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: "Credentials missing" };
  }

  try {
    const storeId = currency === 'INR' ? 'in.element14.com' : currency === 'EUR' ? 'uk.farnell.com' : 'www.newark.com';
    const storeCurrency = storeId === 'in.element14.com' ? 'INR' : storeId === 'uk.farnell.com' ? 'EUR' : 'USD';

    // Build URL requesting up to 5 results
    const url = `https://api.element14.com/catalog/products?term=manuPartNum%3A${encodeURIComponent(mpn)}&resultsSettings.offset=0&resultsSettings.responseGroup=large&storeInfo.id=${storeId}&resultsSettings.numberOfResults=5&resultsSettings.refinements.filters=inStock&callInfo.omitXmlSchema=false&callInfo.responseDataFormat=json&callinfo.apiKey=${apiKey}`;

    console.log(`[${provider}] Fetching part ${mpn} from ${storeId}`);

    const res = await fetch(url, { method: 'GET' });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[${provider}] API returned status ${res.status}: ${errText}`);
      throw new Error(`API returned status: ${res.status}`);
    }

    const data = await res.json();
    const numberOfResults = data?.manufacturerPartNumberSearchReturn?.numberOfResults || 0;

    if (numberOfResults === 0) {
      console.log(`[${provider}] Part not found`);
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    const products = data?.manufacturerPartNumberSearchReturn?.products || [];
    
    // Choose product based on packaging preference
    let product = products[0];

    if (Array.isArray(products) && products.length > 1 && packagingPreference && packagingPreference !== 'Any') {
      for (const prod of products) {
        const descVal = String(prod.displayName || prod.description || '').toLowerCase();
        
        const isReel = descVal.includes('reel') || descVal.includes('tr') || descVal.includes('tape & reel');
        const isCutTape = descVal.includes('cut tape') || descVal.includes('ct') || descVal.includes('strip') || descVal.includes('bag') || descVal.includes('tube') || descVal.includes('tray') || descVal.includes('bulk');
        
        if (packagingPreference === 'Reel' && isReel) {
          product = prod;
          break;
        } else if (packagingPreference === 'Cut Tape' && isCutTape) {
          product = prod;
          break;
        }
      }
    }

    if (!product) {
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    console.log(`[${provider}] Product found: ${product.translatedManufacturerPartNumber || product.sku}`);

    // Get availability from stock or inventory
    const availability = product.stock?.level || product.inventoryCode || 0;

    // Parse prices and MOQ
    const prices = product.prices || [];
    const moq = product.minimumOrderQuantity || 
                product.orderMultiple || 
                product.minimumOrder || 
                (prices.length > 0 ? prices[0].from : 1);

    const evalQty = Math.max(quantity, moq);

    let unitPrice = 0;
    const sortedBreaks = [...prices].sort((a, b) => (a.from || 0) - (b.from || 0));
    for (const p of sortedBreaks) {
      const fromQty = p.from || 0;
      const cost = convertCurrency(p.cost || 0, storeCurrency, currency);
      if (fromQty <= evalQty && cost > 0) {
        unitPrice = cost;
      }
    }

    // Fallback to first price if no match
    if (unitPrice === 0 && sortedBreaks.length > 0) {
      unitPrice = convertCurrency(sortedBreaks[0].cost || 0, storeCurrency, currency);
    }

    // Map all price breaks
    const mappedBreaks: PriceBreak[] = prices.map((p: any) => ({
      quantity: p.from || 0,
      price: convertCurrency(p.cost || 0, storeCurrency, currency)
    })).filter((b: any) => b.quantity > 0 && b.price > 0);

    const alternateParts: string[] = [];
    if (product.rohsSubstitute) {
      alternateParts.push(product.rohsSubstitute);
    }

    const description = product.displayName || product.description || "";
    const packaging = product.packagingCode || "";

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

export async function fetchElement14Standardized(mpn: string, currency: string = 'INR'): Promise<StandardProviderResult> {
  const apiKey = process.env.ELEMENT14_API_KEY;
  const provider = "Element14";

  const emptyCategories: StandardPackagingCategories = {
    "Custom Reel / DigiReel": [],
    "Cut-Tape": [],
    "Top-reel": []
  };

  if (!apiKey) {
    return { provider, categories: emptyCategories, description: "", alternateParts: [], availability: 0 };
  }

  try {
    const storeId = currency === 'INR' ? 'in.element14.com' : currency === 'EUR' ? 'uk.farnell.com' : 'www.newark.com';
    const storeCurrency = storeId === 'in.element14.com' ? 'INR' : storeId === 'uk.farnell.com' ? 'EUR' : 'USD';

    const url = `https://api.element14.com/catalog/products?term=manuPartNum%3A${encodeURIComponent(mpn)}&resultsSettings.offset=0&resultsSettings.responseGroup=large&storeInfo.id=${storeId}&resultsSettings.numberOfResults=10&resultsSettings.refinements.filters=inStock&callInfo.omitXmlSchema=false&callInfo.responseDataFormat=json&callinfo.apiKey=${apiKey}`;

    const res = await fetch(url, { method: 'GET' });

    if (!res.ok) {
      return { provider, categories: emptyCategories, description: "", alternateParts: [], availability: 0 };
    }

    const data = await res.json();
    const numberOfResults = data?.manufacturerPartNumberSearchReturn?.numberOfResults || 0;

    if (numberOfResults === 0 || !data?.manufacturerPartNumberSearchReturn?.products) {
      return { provider, categories: emptyCategories, description: "", alternateParts: [], availability: 0 };
    }

    const products = data.manufacturerPartNumberSearchReturn.products;

    const categories: StandardPackagingCategories = {
      "Custom Reel / DigiReel": [],
      "Cut-Tape": [],
      "Top-reel": []
    };

    let mainDescription = "";
    const alternatePartsSet = new Set<string>();
    let maxAvailability = 0;

    for (const prod of products) {
      if (!mainDescription) {
        mainDescription = prod.displayName || prod.description || "";
      }

      const currentAvail = prod.stock?.level || prod.inventoryCode || 0;
      if (currentAvail > maxAvailability) {
        maxAvailability = currentAvail;
      }

      const descVal = String(prod.displayName || prod.description || '').toLowerCase();
      const packagingVal = String(prod.packagingCode || '').toLowerCase();
      
      const isCustomReel = descVal.includes('custom reel') || packagingVal.includes('cr');
      const isTopReel = descVal.includes('reel') || descVal.includes('tr') || descVal.includes('tape & reel');
      const isCutTape = descVal.includes('cut tape') || descVal.includes('ct') || descVal.includes('strip') || descVal.includes('bag') || descVal.includes('tube') || descVal.includes('tray') || descVal.includes('bulk');

      const prices = prod.prices || [];
      const mappedBreaks: StandardPriceTier[] = prices.map((p: any) => ({
        Qty: p.from || 0,
        unit_price: convertCurrency(p.cost || 0, storeCurrency, currency),
        currency
      })).filter((b: any) => b.Qty > 0 && b.unit_price > 0);

      if (isCustomReel && categories["Custom Reel / DigiReel"].length === 0) {
        categories["Custom Reel / DigiReel"] = mappedBreaks;
      } else if (isCutTape && categories["Cut-Tape"].length === 0) {
        categories["Cut-Tape"] = mappedBreaks;
      } else if (isTopReel && categories["Top-reel"].length === 0) {
        categories["Top-reel"] = mappedBreaks;
      }

      if (prod.rohsSubstitute && prod.rohsSubstitute.trim() !== mpn) {
        alternatePartsSet.add(prod.rohsSubstitute.trim());
      }
    }

    return {
      provider,
      categories,
      description: mainDescription,
      alternateParts: Array.from(alternatePartsSet),
      availability: maxAvailability
    };

  } catch (e) {
    return { provider, categories: emptyCategories, description: "", alternateParts: [], availability: 0 };
  }
}

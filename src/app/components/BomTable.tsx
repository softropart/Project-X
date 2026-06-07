'use client';

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, ShoppingCart, ChevronDown, DollarSign, Info, Hash, Settings } from 'lucide-react';
import { parseExcelFile, ParsedBomItem } from '@/lib/excel-parser';
import { fetchStandardizedPartData } from '@/app/actions/parts';
import { StandardPartData, StandardPackagingCategories, StandardPriceTier, StandardDistributorData } from '@/lib/providers';

export interface CalculatedPrice {
  provider: string;
  unitPrice: number | null;
  totalCost: number | null;
  availability: number | null;
  moq: number;
  isWinner: boolean;
  error?: string;
  priceBreaks?: Array<{ quantity: number; price: number }>;
}

interface BomItemState extends ParsedBomItem {
  status: 'idle' | 'fetching' | 'success' | 'error';
  standardData: StandardPartData | null;
  prices: CalculatedPrice[];
  selectedProvider: string | null;
  selectedCost: number | null;
  moqUpdated?: boolean;
  newQty?: number;
  moqRatio?: number;
  selectedMpn?: string;
  description?: string;
  packagingPreference?: 'Any' | 'Cut Tape' | 'Reel';
  alternateParts?: string[];
  suggestedQty?: number | null;
  suggestedSavings?: number | null;
  alternateParts?: string[];
}

const CURRENCIES = [
  { code: 'INR', symbol: '₹' },
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
];

function calculatePricesFromStandardData(
  data: StandardPartData | null,
  mpn: string,
  targetQty: number,
  pref: 'Any' | 'Cut Tape' | 'Reel'
): CalculatedPrice[] {
  if (!data || !data[mpn]) return [];
  const partData = data[mpn];

  const providers = ['DigiKey', 'Mouser', 'Element14'] as const;
  const results: CalculatedPrice[] = [];

  for (const provider of providers) {
    const distData = partData.pricing_by_distributor[provider] as unknown as StandardDistributorData;
    if (!distData || !distData.packaging) continue;

    const availability = distData.availability || 0;

    let tiersToConsider: StandardPriceTier[] = [];
    const ctTiers = distData.packaging["Cut-Tape"] || [];
    const crTiers = distData.packaging["Custom Reel / DigiReel"] || [];
    const trTiers = distData.packaging["Top-reel"] || [];

    if (pref === 'Cut Tape') {
      tiersToConsider = [...ctTiers];
    } else if (pref === 'Reel') {
      tiersToConsider = [...crTiers, ...trTiers];
    } else {
      tiersToConsider = [...ctTiers, ...crTiers, ...trTiers];
    }

    if (tiersToConsider.length === 0) {
      results.push({
        provider,
        unitPrice: null,
        totalCost: null,
        availability: availability > 0 ? availability : 0,
        moq: 1,
        isWinner: false,
        error: "No matching packaging found"
      });
      continue;
    }

    const moq = Math.min(...tiersToConsider.map(t => t.Qty));
    const evalQty = Math.max(targetQty, moq);

    let unitPrice = 0;
    const sortedTiers = [...tiersToConsider].sort((a, b) => a.Qty - b.Qty);
    for (const tier of sortedTiers) {
      if (tier.Qty <= evalQty && tier.unit_price > 0) {
        unitPrice = tier.unit_price;
      }
    }

    if (unitPrice === 0 && sortedTiers.length > 0) {
      unitPrice = sortedTiers[0].unit_price;
    }

    // Map price breaks for uplift checking
    const priceBreaks = sortedTiers.map(tier => ({
      quantity: tier.Qty,
      price: tier.unit_price
    }));

    results.push({
      provider,
      unitPrice: unitPrice > 0 ? unitPrice : null,
      totalCost: unitPrice > 0 ? parseFloat((unitPrice * evalQty).toFixed(3)) : null,
      availability,
      moq,
      isWinner: false,
      priceBreaks
    });
  }

  return results;
}

export default function BomTable() {
  const [items, setItems] = useState<BomItemState[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currency, setCurrency] = useState('INR');
  const [assemblies, setAssemblies] = useState(1);
  const [globalPackaging, setGlobalPackaging] = useState<'Any' | 'Cut Tape' | 'Reel'>('Any');
  const [hasFetched, setHasFetched] = useState(false);

  const currencySymbol = useMemo(() => CURRENCIES.find(c => c.code === currency)?.symbol || '₹', [currency]);

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setIsParsing(true);
    setHasFetched(false);
    try {
      const parsedItems = await parseExcelFile(file);
      if (parsedItems.length === 0) {
        setErrorMsg('No valid parts found in the uploaded file. Please ensure it has MPN and Quantity columns.');
      } else {
        setItems(parsedItems.map(item => ({
          ...item,
          status: 'idle',
          standardData: null,
          prices: [],
          selectedProvider: null,
          selectedCost: null,
          packagingPreference: 'Any',
        })));
      }
    } catch (error: any) {
      setErrorMsg(error.message || 'Failed to parse file.');
    } finally {
      setIsParsing(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      handleFileUpload(file);
    }
  }, []);

  // Compute majority distributor to break ties dynamically
  const computeMajorityDistributor = (itemsList: BomItemState[]) => {
    const wins: Record<string, number> = { DigiKey: 0, Mouser: 0, Element14: 0 };
    itemsList.forEach(item => {
      if (item.selectedProvider) {
        wins[item.selectedProvider] = (wins[item.selectedProvider] || 0) + 1;
      }
    });

    let majority = 'DigiKey';
    let maxWins = -1;
    for (const [provider, count] of Object.entries(wins)) {
      if (count > maxWins) {
        maxWins = count;
        majority = provider;
      }
    }
    return majority;
  };

  const findWinnerAndMoq = (prices: CalculatedPrice[], targetQty: number, currentItems: BomItemState[]) => {
    const validResults = prices.filter(r => r.totalCost !== null && !r.error && r.availability !== null && r.availability > 0);
    let winner: string | null = null;
    let lowestCost: number | null = null;
    let suggestedQty: number | null = null;
    let suggestedSavings: number | null = null;

    if (validResults.length > 0) {
      const sortedByCost = [...validResults].sort((a, b) => (a.totalCost || 0) - (b.totalCost || 0));
      lowestCost = sortedByCost[0].totalCost;
      winner = sortedByCost[0].provider;

      if (sortedByCost.length > 1 && sortedByCost[0].totalCost === sortedByCost[1].totalCost) {
        const majority = computeMajorityDistributor(currentItems);
        const tied = sortedByCost.filter(r => r.totalCost === sortedByCost[0].totalCost).map(r => r.provider);
        if (tied.includes(majority)) {
          winner = majority;
        }
      }

      // Check for quantity uplift opportunity across ALL providers
      const currentBestCost = lowestCost;
      let bestUpliftQty: number | null = null;
      let bestUpliftCost: number | null = null;
      let bestUpliftSavings: number | null = null;

      console.log(`[Uplift Check] Current best cost for ${targetQty} units: ${currentBestCost}`);

      for (const priceObj of validResults) {
        const priceBreaks = priceObj.priceBreaks || [];
        const moq = priceObj.moq || 1;
        const actualQty = Math.max(targetQty, moq);

        console.log(`[Uplift Check] ${priceObj.provider} - actualQty: ${actualQty}, priceBreaks:`, priceBreaks);

        // Check next price tiers
        for (const pb of priceBreaks) {
          if (pb.quantity > actualQty && pb.price > 0 && pb.quantity <= actualQty * 2) {
            const nextTierTotalCost = pb.quantity * pb.price;

            console.log(`[Uplift Check] ${priceObj.provider} - Tier at qty ${pb.quantity}: price=${pb.price}, totalCost=${nextTierTotalCost}`);

            // Algorithm: If (NextQty × NextTierPrice) < (CurrentBestCost)
            if (nextTierTotalCost < currentBestCost!) {
              const savings = currentBestCost! - nextTierTotalCost;

              console.log(`[Uplift Check] 💡 Found savings! Buy ${pb.quantity} for ${nextTierTotalCost} instead of ${actualQty} for ${currentBestCost} = Save ${savings}`);

              // Keep the best uplift suggestion (most savings or smallest qty increase)
              if (!bestUpliftSavings || savings > bestUpliftSavings ||
                (savings === bestUpliftSavings && pb.quantity < bestUpliftQty!)) {
                bestUpliftQty = pb.quantity;
                bestUpliftCost = nextTierTotalCost;
                bestUpliftSavings = savings;
              }
            }

            // Only check the immediate next tier
            break;
          }
        }
      }

      if (bestUpliftQty && bestUpliftSavings) {
        suggestedQty = bestUpliftQty;
        suggestedSavings = bestUpliftSavings;
        console.log(`[Uplift Check] ✅ Final suggestion: Buy ${suggestedQty} and save ${suggestedSavings}`);
      } else {
        console.log(`[Uplift Check] ❌ No uplift opportunity found`);
      }
    }

    if (winner) {
      prices.forEach(p => p.isWinner = (p.provider === winner));
    }

    const selectedPriceObj = prices.find(p => p.provider === winner);
    const activeMoq = selectedPriceObj?.moq || 1;
    const newQty = Math.max(targetQty, activeMoq);
    const moqUpdated = newQty > targetQty;
    const moqRatio = newQty / targetQty;

    return {
      winner,
      lowestCost,
      newQty,
      moqUpdated,
      moqRatio,
      suggestedQty,
      suggestedSavings
    };
  };

  const fetchPricesForItems = async (itemsToFetch = items, targetCurrency = currency, targetPackaging = globalPackaging) => {
    if (itemsToFetch.length === 0) return;

    setItems(prev => prev.map(item => ({ ...item, status: 'fetching', prices: [], selectedProvider: null, selectedCost: null })));
    setHasFetched(true);

    itemsToFetch.forEach(async (item) => {
      try {
        const itemPkg = item.packagingPreference && item.packagingPreference !== 'Any' ? item.packagingPreference : targetPackaging;
        const targetQty = item.quantity * assemblies;

        // Fetch new schema data
        const standardData = await fetchStandardizedPartData(item.mpn, targetCurrency);

        setItems(prev => prev.map(p => {
          if (p.id === item.id) {
            const calculatedPrices = calculatePricesFromStandardData(standardData, item.mpn, targetQty, itemPkg);
            const { winner, lowestCost, newQty, moqUpdated, moqRatio, suggestedQty, suggestedSavings } = findWinnerAndMoq(calculatedPrices, targetQty, prev);

            const partInfo = standardData[item.mpn];

            return {
              ...p,
              status: 'success',
              standardData,
              prices: calculatedPrices,
              selectedProvider: winner,
              selectedCost: lowestCost,
              moqUpdated,
              newQty,
              moqRatio,
              selectedMpn: item.mpn,
              description: partInfo?.description || '',
              alternateParts: partInfo?.alias_part_numbers || [],
              suggestedQty,
              suggestedSavings,
            };
          }
          return p;
        }));
      } catch (e) {
        setItems(prev => prev.map(p =>
          p.id === item.id
            ? { ...p, status: 'error' }
            : p
        ));
      }
    });
  };

  // Trigger background refetch when currency or packaging selection updates
  useEffect(() => {
    if (hasFetched && items.length > 0) {
      fetchPricesForItems(items, currency, globalPackaging);
    }
  }, [currency, globalPackaging]);

  // Recalculates provider cost based on user-edited baseline quantities
  const recalculateAllPrices = (targetItems: BomItemState[], currentAssemblies: number) => {
    return targetItems.map(item => {
      const baseQty = item.quantity * currentAssemblies;
      const pref = item.packagingPreference || globalPackaging;

      const calculatedPrices = calculatePricesFromStandardData(item.standardData, item.selectedMpn || item.mpn, baseQty, pref);

      // ALWAYS re-evaluate winner at new quantity to get best price
      const res = findWinnerAndMoq(calculatedPrices, baseQty, targetItems);

      return {
        ...item,
        prices: calculatedPrices,
        selectedProvider: res.winner,
        selectedCost: res.lowestCost,
        newQty: res.newQty,
        moqUpdated: res.moqUpdated,
        moqRatio: res.moqRatio,
        suggestedQty: res.suggestedQty,
        suggestedSavings: res.suggestedSavings,
      };
    });
  };

  const handleOrderQtyChange = (itemId: string, newOrderQty: number) => {
    if (isNaN(newOrderQty) || newOrderQty < 1) return;

    setItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const pref = item.packagingPreference || globalPackaging;
        const calculatedPrices = calculatePricesFromStandardData(item.standardData, item.selectedMpn || item.mpn, newOrderQty, pref);

        // ALWAYS re-evaluate to find the best winner at new quantity
        const res = findWinnerAndMoq(calculatedPrices, newOrderQty, prev);

        return {
          ...item,
          quantity: newOrderQty / assemblies,
          prices: calculatedPrices,
          selectedProvider: res.winner,
          selectedCost: res.lowestCost,
          newQty: res.newQty,
          moqUpdated: res.moqUpdated,
          moqRatio: res.moqRatio,
          suggestedQty: res.suggestedQty,
          suggestedSavings: res.suggestedSavings,
        };
      }
      return item;
    }));
  };

  const handleAssembliesChange = (val: number) => {
    if (isNaN(val) || val < 1) return;
    setAssemblies(val);
    setItems(prev => recalculateAllPrices(prev, val));
  };

  const handleGlobalPackagingChange = (pkg: 'Any' | 'Cut Tape' | 'Reel') => {
    setGlobalPackaging(pkg);
  };

  const handleItemPackagingChange = async (itemId: string, newPkg: 'Any' | 'Cut Tape' | 'Reel') => {
    setItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const targetQty = item.quantity * assemblies;
        const calculatedPrices = calculatePricesFromStandardData(item.standardData, item.selectedMpn || item.mpn, targetQty, newPkg);
        const { winner, lowestCost, newQty, moqUpdated, moqRatio } = findWinnerAndMoq(calculatedPrices, targetQty, prev);

        return {
          ...item,
          packagingPreference: newPkg,
          prices: calculatedPrices,
          selectedProvider: winner,
          selectedCost: lowestCost,
          newQty,
          moqUpdated,
          moqRatio
        };
      }
      return item;
    }));
  };

  const handleMpnSelect = (itemId: string, mpnToSelect: string) => {
    console.log("Alternative part selection to be implemented later", itemId, mpnToSelect);
  };

  const handleProviderChange = (itemId: string, newProvider: string) => {
    setItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const selectedPriceObj = item.prices.find(p => p.provider === newProvider);
        const moq = selectedPriceObj?.moq || 1;
        const requiredQty = item.quantity * assemblies;
        const newQty = Math.max(requiredQty, moq);
        const moqUpdated = newQty > requiredQty;
        const moqRatio = newQty / requiredQty;

        return {
          ...item,
          selectedProvider: newProvider,
          selectedCost: selectedPriceObj?.totalCost ?? null,
          newQty,
          moqUpdated,
          moqRatio,
        };
      }
      return item;
    }));
  };

  // Compile top level dashboard statistics
  const reportData = useMemo(() => {
    if (items.length === 0 || !hasFetched) return null;

    let totalCost = 0;
    let partsAvailable = 0;
    let outOfStock = 0;
    let costSaved = 0;
    const splitCounts: Record<string, number> = { DigiKey: 0, Mouser: 0, Element14: 0 };

    items.forEach(item => {
      if (item.status === 'success') {
        const selectedCostVal = item.selectedCost;
        if (selectedCostVal !== null && selectedCostVal > 0) {
          totalCost += selectedCostVal;
          partsAvailable++;

          if (item.selectedProvider) {
            splitCounts[item.selectedProvider] = (splitCounts[item.selectedProvider] || 0) + 1;
          }

          const validPrices = item.prices.filter(p => p.unitPrice !== null && !p.error && p.availability !== null && p.availability > 0);
          if (validPrices.length > 1) {
            const sortedByCost = [...validPrices].sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));
            const maxCost = sortedByCost[0].totalCost || 0;
            if (maxCost > selectedCostVal) {
              costSaved += (maxCost - selectedCostVal);
            }
          }
        } else {
          outOfStock++;
        }
      } else if (item.status === 'error') {
        outOfStock++;
      }
    });

    return {
      totalCost,
      partsAvailable,
      outOfStock,
      costSaved,
      splitCounts
    };
  }, [items, hasFetched, assemblies]);

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 duration-700 ease-out">

      {/* Controls & Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 bg-white/60 backdrop-blur-xl border border-slate-200/50 shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-2xl">
        <div>
          <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-600">BOM Workspace</h2>
          <p className="text-sm text-slate-500 font-medium">{items.length > 0 ? `${items.length} Parts Loaded` : 'No file uploaded yet'}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Assemblies Multiplier Box */}
          <div className="relative flex items-center">
            <span className="bg-slate-50 border border-r-0 border-slate-200 rounded-l-xl px-3 py-2.5 text-slate-500 font-bold text-xs flex items-center gap-1">
              <Settings className="w-3.5 h-3.5" /> Assemblies
            </span>
            <input
              type="number"
              min="1"
              value={assemblies}
              onChange={(e) => handleAssembliesChange(parseInt(e.target.value))}
              className="w-16 bg-white border border-slate-200 text-slate-800 font-bold py-2 px-3 rounded-r-xl hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm"
            />
          </div>

          {/* Packaging Preference Selection */}
          <div className="relative group">
            <select
              value={globalPackaging}
              onChange={(e) => handleGlobalPackagingChange(e.target.value as any)}
              className="appearance-none bg-white border border-slate-200 text-slate-700 font-medium py-2.5 pl-10 pr-10 rounded-xl hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm cursor-pointer text-sm"
            >
              <option value="Any">Any Packaging</option>
              <option value="Cut Tape">Cut Tape</option>
              <option value="Reel">Tape & Reel</option>
            </select>
            <Upload className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none transition-transform group-hover:translate-y-[1px]" />
          </div>

          {/* Currency Selector */}
          <div className="relative group">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="appearance-none bg-white border border-slate-200 text-slate-700 font-medium py-2.5 pl-10 pr-10 rounded-xl hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm cursor-pointer text-sm"
            >
              {CURRENCIES.map(c => (
                <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>
              ))}
            </select>
            <DollarSign className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none transition-transform group-hover:translate-y-[1px]" />
          </div>

          {items.length > 0 && (
            <button
              onClick={() => fetchPricesForItems()}
              className="group flex items-center gap-2 bg-gradient-to-b from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-6 py-2.5 rounded-xl font-medium transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 text-sm"
            >
              <ShoppingCart className="w-4 h-4 transition-transform group-hover:-rotate-12" />
              <span>Fetch Best Prices</span>
            </button>
          )}
        </div>
      </div>

      {/* Dynamic Report Dashboard */}
      {reportData && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-gradient-to-br from-blue-500/10 to-indigo-500/10 backdrop-blur-md border border-blue-200/50 p-5 rounded-2xl shadow-sm flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Total Order Cost</span>
            <span className="text-2xl font-bold text-slate-900 mt-2">
              {currencySymbol}{reportData.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 backdrop-blur-md border border-emerald-200/50 p-5 rounded-2xl shadow-sm flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Parts Available</span>
            <span className="text-2xl font-bold text-slate-900 mt-2">
              {reportData.partsAvailable} / {items.length}
            </span>
          </div>
          <div className="bg-gradient-to-br from-rose-500/10 to-pink-500/10 backdrop-blur-md border border-rose-200/50 p-5 rounded-2xl shadow-sm flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Out of Stock</span>
            <span className="text-2xl font-bold text-slate-900 mt-2">
              {reportData.outOfStock} Components
            </span>
          </div>
          <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 backdrop-blur-md border border-amber-200/50 p-5 rounded-2xl shadow-sm flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Estimated Savings</span>
            <span className="text-2xl font-bold text-amber-700 mt-2">
              {currencySymbol}{reportData.costSaved.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="bg-gradient-to-br from-slate-500/10 to-slate-700/10 backdrop-blur-md border border-slate-200/50 p-5 rounded-2xl shadow-sm flex flex-col justify-between">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Distributor Split</span>
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">DK: {reportData.splitCounts.DigiKey || 0}</span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-50 border border-orange-200 text-orange-700">MS: {reportData.splitCounts.Mouser || 0}</span>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700">E14: {reportData.splitCounts.Element14 || 0}</span>
            </div>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="bg-red-50/80 backdrop-blur-md border border-red-200 p-4 rounded-xl flex items-start gap-3 shadow-sm duration-300">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-red-700 text-sm font-medium">{errorMsg}</p>
        </div>
      )}

      {items.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-3xl p-16 text-center transition-all duration-300 ease-out ${isDragging
            ? 'border-blue-400 bg-blue-50/50 scale-[1.02] shadow-xl shadow-blue-500/10'
            : 'border-slate-200 hover:border-slate-300 bg-white/50 hover:bg-white/80 shadow-sm hover:shadow-md'
            }`}
        >
          {isParsing ? (
            <div className="flex flex-col items-center gap-4 text-slate-500">
              <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
              <p className="font-medium text-lg">Parsing Excel data...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              <div className="p-5 bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] ring-1 ring-slate-100 mb-2">
                <FileSpreadsheet className="w-12 h-12 text-blue-600" />
              </div>
              <div>
                <p className="text-xl font-bold text-slate-800">Drag & drop your BOM file</p>
                <p className="text-slate-500 mt-2 font-medium">Supports .xlsx and .csv formats</p>
              </div>
              <label className="mt-4 cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  accept=".xlsx, .xls, .csv"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleFileUpload(e.target.files[0]);
                    }
                  }}
                />
                <span className="bg-white border border-slate-200 text-slate-700 hover:text-slate-900 hover:border-slate-300 hover:bg-slate-50 px-6 py-3 rounded-xl font-semibold transition-all shadow-sm hover:shadow inline-block">
                  Browse Files
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="bg-white/80 backdrop-blur-xl border border-slate-200/60 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden transition-all">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-50/80 backdrop-blur-sm border-b border-slate-200/80 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-4 w-12 text-center"><Hash className="w-3.5 h-3.5 mx-auto" /></th>
                  <th className="px-6 py-4">Part Number (MPN)</th>
                  <th className="px-6 py-4">Description</th>
                  <th className="px-6 py-4 w-24">BOM Qty</th>
                  <th className="px-6 py-4 w-28">Order Qty</th>
                  <th className="px-6 py-4 w-44">Pkg Option</th>
                  <th className="px-6 py-4 w-64">Selected Provider</th>
                  <th className="px-6 py-4 text-right w-40">Cost ({currency})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item, idx) => {
                  const highMoqRatio = item.moqRatio && item.moqRatio > 1.3;
                  const validPrices = item.prices.filter(p => p.unitPrice !== null && !p.error);
                  const activeProvider = item.selectedProvider;
                  const alternateParts = item.alternateParts || [];

                  let activeCost = null;
                  if (activeProvider) {
                    const pData = validPrices.find(p => p.provider === activeProvider);
                    if (pData) {
                      activeCost = pData.totalCost;
                    }
                  }

                  return (
                    <tr key={item.id} className={`transition-colors group ${highMoqRatio ? 'bg-amber-50/20' : 'bg-white'}`}>
                      <td className="px-4 py-4 text-center font-semibold text-slate-400">
                        {idx + 1}
                      </td>

                      <td className="px-6 py-4 flex items-start gap-2">
                        <div className="flex-grow">
                          <div className="font-semibold text-slate-800 flex items-center gap-2">
                            <span>{item.mpn}</span>

                            {/* Alias Hover Tooltip Info Icon */}
                            {alternateParts.length > 0 && (
                              <div className="relative inline-block group cursor-pointer z-20">
                                <Info className="w-4 h-4 text-slate-400 hover:text-blue-500 transition-colors" />
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-slate-900/95 backdrop-blur-md text-white text-[10px] p-3 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
                                  <p className="font-bold border-b border-slate-700 pb-1 mb-1 text-slate-300 uppercase tracking-wide">Equivalent Alias Parts</p>
                                  <div className="space-y-1 max-h-32 overflow-y-auto font-mono">
                                    {alternateParts.map(alt => (
                                      <div key={alt} className="bg-white/10 px-1 py-0.5 rounded text-center">{alt}</div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                          {highMoqRatio && (
                            <div className="mt-1 text-[10px] text-amber-600 font-medium flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> High MOQ ({item.moqRatio?.toFixed(1)}x)
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="px-6 py-4 max-w-[180px] overflow-x-auto whitespace-nowrap scrollbar-thin text-slate-500 font-medium text-xs">
                        {typeof item.description === 'string'
                          ? item.description || '-'
                          : (item.description as any)?.ProductDescription || (item.description as any)?.DetailedDescription || '-'}
                      </td>

                      <td className="px-6 py-4 font-semibold text-slate-600">
                        {item.quantity}
                      </td>

                      <td className="px-6 py-4">
                        <input
                          type="number"
                          min="1"
                          value={item.newQty ?? item.quantity * assemblies}
                          onChange={(e) => handleOrderQtyChange(item.id, parseInt(e.target.value))}
                          className="w-20 font-bold border rounded-lg px-2 py-1 focus:outline-none transition-all bg-blue-50/50 text-blue-700 border-blue-200 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                        />
                        {item.moqUpdated && (
                          <div className="mt-1">
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-amber-700 bg-amber-100 border-amber-200" title="Adjusted to meet Vendor MOQ">
                              MOQ APPLIED
                            </span>
                          </div>
                        )}
                        {item.suggestedQty && item.suggestedSavings && (
                          <div className="mt-1">
                            <button
                              onClick={() => handleOrderQtyChange(item.id, item.suggestedQty!)}
                              className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-green-700 bg-green-50 border-green-200 hover:bg-green-100 transition-colors cursor-pointer"
                              title={`Buy ${item.suggestedQty} instead and save ${currencySymbol}${item.suggestedSavings.toFixed(2)}`}
                            >
                              💡 Buy {item.suggestedQty} (Save {currencySymbol}{item.suggestedSavings.toFixed(2)})
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="px-6 py-4">
                        <select
                          value={item.packagingPreference || 'Any'}
                          onChange={(e) => handleItemPackagingChange(item.id, e.target.value as any)}
                          className="bg-white border border-slate-200 text-slate-700 text-xs font-semibold py-1 px-2 rounded-lg hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer w-32"
                        >
                          <option value="Any">Any Pkg</option>
                          <option value="Cut Tape">Cut Tape</option>
                          <option value="Reel">Tape & Reel</option>
                        </select>
                      </td>

                      <td className="px-6 py-4">
                        {item.status === 'idle' && <span className="text-slate-400 italic font-medium">Awaiting fetch...</span>}

                        {item.status === 'fetching' && (
                          <div className="flex items-center gap-2 text-blue-600 font-medium">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Searching...</span>
                          </div>
                        )}

                        {item.status === 'error' && (
                          <div className="flex items-center gap-2 text-red-600 font-medium">
                            <AlertCircle className="w-4 h-4" />
                            <span>Failed</span>
                          </div>
                        )}

                        {item.status === 'success' && validPrices.length > 0 && (
                          <div className="relative flex items-center gap-1.5">
                            <div className="relative flex-grow">
                              <select
                                value={item.selectedProvider || ''}
                                onChange={(e) => handleProviderChange(item.id, e.target.value)}
                                className={`appearance-none w-full border font-semibold py-1.5 pl-3 pr-8 rounded-lg outline-none transition-all cursor-pointer text-xs ${item.selectedProvider === item.prices.find(p => p.isWinner)?.provider
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800 focus:ring-2 focus:ring-emerald-500/20'
                                  : 'bg-white border-slate-200 text-slate-700 focus:ring-2 focus:ring-blue-500/20'
                                  }`}
                              >
                                {validPrices.map(p => {
                                  const stockText = p.availability === 0 ? "Out of Stock" : `Stock: ${p.availability?.toLocaleString()}`;
                                  return (
                                    <option key={p.provider} value={p.provider}>
                                      {p.provider} ({currencySymbol}{p.unitPrice?.toFixed(2)} | {stockText}) {p.isWinner ? '✨ (Best)' : ''}
                                    </option>
                                  );
                                })}
                              </select>
                              <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                          </div>
                        )}

                        {item.status === 'success' && validPrices.length === 0 && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border text-rose-600 bg-rose-50 border-rose-100">
                            <AlertCircle className="w-3.5 h-3.5" /> No Stock
                          </span>
                        )}
                      </td>

                      <td className="px-6 py-4 text-right">
                        {item.status === 'success' && activeCost !== null ? (
                          <div className="flex flex-col items-end">
                            <span className="font-bold text-base text-slate-900">
                              {currencySymbol}{activeCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Total</span>
                          </div>
                        ) : (
                          <span className="text-slate-300 font-medium">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

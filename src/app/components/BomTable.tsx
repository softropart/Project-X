'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, ShoppingCart, ChevronDown, DollarSign } from 'lucide-react';
import { parseExcelFile, ParsedBomItem } from '@/lib/excel-parser';
import { fetchBestPrices, BestPriceResult } from '@/app/actions/parts';
import { ProviderPriceResult } from '@/lib/providers';

interface BomItemState extends ParsedBomItem {
  status: 'idle' | 'fetching' | 'success' | 'error';
  prices: ProviderPriceResult[];
  selectedProvider: string | null;
  selectedCost: number | null;
  moqUpdated?: boolean;
  originalQty?: number;
  newQty?: number;
  moqRatio?: number;
  originalResult?: BestPriceResult;
  alternatives?: BestPriceResult[];
  selectedMpn?: string;
}

const CURRENCIES = [
  { code: 'INR', symbol: '₹' },
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
];

export default function BomTable() {
  const [items, setItems] = useState<BomItemState[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currency, setCurrency] = useState('INR');

  const currencySymbol = useMemo(() => CURRENCIES.find(c => c.code === currency)?.symbol || '₹', [currency]);

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setIsParsing(true);
    try {
      const parsedItems = await parseExcelFile(file);
      if (parsedItems.length === 0) {
        setErrorMsg('No valid parts found in the uploaded file. Please ensure it has MPN and Quantity columns.');
      } else {
        setItems(parsedItems.map(item => ({
          ...item,
          status: 'idle',
          prices: [],
          selectedProvider: null,
          selectedCost: null,
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

  const fetchPricesForItems = async () => {
    setItems(prev => prev.map(item => ({ ...item, status: 'fetching', prices: [], selectedProvider: null, selectedCost: null })));

    items.forEach(async (item) => {
      try {
        const res = await fetchBestPrices(item.mpn, item.quantity, currency);
        setItems(prev => prev.map(p => 
          p.id === item.id 
            ? { 
                ...p, 
                status: 'success', 
                prices: res.results, 
                selectedProvider: res.winner, 
                selectedCost: res.lowestCost,
                moqUpdated: res.moqUpdated,
                originalQty: res.originalQty,
                newQty: res.newQty,
                moqRatio: res.moqRatio,
                originalResult: res,
                alternatives: res.alternatives,
                selectedMpn: res.mpn
              } 
            : p
        ));
      } catch (e) {
        setItems(prev => prev.map(p => 
          p.id === item.id 
            ? { ...p, status: 'error' } 
            : p
        ));
      }
    });
  };

  const handleMpnSelect = (itemId: string, mpnToSelect: string) => {
    setItems(prev => prev.map(item => {
      if (item.id === itemId && item.originalResult) {
        let selectedRes = item.originalResult;
        if (mpnToSelect !== item.originalResult.mpn) {
          selectedRes = item.alternatives?.find(a => a.mpn === mpnToSelect) || item.originalResult;
        }

        return {
          ...item,
          prices: selectedRes.results,
          selectedProvider: selectedRes.winner,
          selectedCost: selectedRes.lowestCost,
          moqUpdated: selectedRes.moqUpdated,
          newQty: selectedRes.newQty,
          moqRatio: selectedRes.moqRatio,
          selectedMpn: selectedRes.mpn
        };
      }
      return item;
    }));
  };

  const handleProviderChange = (itemId: string, newProvider: string) => {
    setItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const selectedPriceObj = item.prices.find(p => p.provider === newProvider);
        const moq = selectedPriceObj?.moq || 1;
        const requiredQty = item.quantity;
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

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 duration-700 ease-out">
      
      {/* Controls & Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 bg-white/60 backdrop-blur-xl border border-slate-200/50 shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-2xl">
        <div>
          <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-600">BOM Workspace</h2>
          <p className="text-sm text-slate-500 font-medium">{items.length > 0 ? `${items.length} Parts Loaded` : 'No file uploaded yet'}</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          {/* Currency Selector */}
          <div className="relative group">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="appearance-none bg-white border border-slate-200 text-slate-700 font-medium py-2.5 pl-10 pr-10 rounded-xl hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-sm cursor-pointer"
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
              onClick={fetchPricesForItems}
              className="group flex items-center gap-2 bg-gradient-to-b from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-6 py-2.5 rounded-xl font-medium transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
            >
              <ShoppingCart className="w-4 h-4 transition-transform group-hover:-rotate-12" />
              <span>Fetch Best Prices</span>
            </button>
          )}
        </div>
      </div>

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
          className={`border-2 border-dashed rounded-3xl p-16 text-center transition-all duration-300 ease-out ${
            isDragging 
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
              <thead className="bg-slate-50/80 backdrop-blur-sm border-b border-slate-200/80 text-slate-500 uppercase tracking-wider text-[11px] font-bold">
                <tr>
                  <th className="px-6 py-5">Part Number (MPN)</th>
                  <th className="px-6 py-5 w-24">BOM Qty</th>
                  <th className="px-6 py-5 w-24">Order Qty</th>
                  <th className="px-6 py-5 w-64">Selected Provider</th>
                  <th className="px-6 py-5 text-right w-40">Cost ({currency})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => {
                  const hasAlternates = item.alternatives && item.alternatives.length > 0;
                  const currentlySelectedMpn = item.selectedMpn || item.mpn;
                  const highMoqRatio = item.moqRatio && item.moqRatio > 1.3;

                  const rowOptions = [
                    { 
                      isOriginal: true, 
                      mpn: item.mpn, 
                      resultObj: item.originalResult,
                      prices: item.originalResult ? item.originalResult.results : item.prices,
                      moqUpdated: item.originalResult ? item.originalResult.moqUpdated : item.moqUpdated,
                      newQty: item.originalResult ? item.originalResult.newQty : item.newQty,
                    },
                    ...(item.alternatives || []).map(alt => ({
                      isOriginal: false,
                      mpn: alt.mpn,
                      resultObj: alt,
                      prices: alt.results,
                      moqUpdated: alt.moqUpdated,
                      newQty: alt.newQty,
                    }))
                  ];

                  return (
                    <React.Fragment key={item.id}>
                      {rowOptions.map((rowOpt) => {
                        const isSelected = currentlySelectedMpn === rowOpt.mpn;
                        const isOriginal = rowOpt.isOriginal;
                        
                        const activeProvider = isSelected ? item.selectedProvider : rowOpt.resultObj?.winner;
                        const validPrices = rowOpt.prices.filter(p => p.unitPrice !== null && p.availability && p.availability >= item.quantity);
                        
                        let activeCost = null;
                        if (activeProvider) {
                           const pData = validPrices.find(p => p.provider === activeProvider);
                           if (pData) {
                             activeCost = pData.totalCost;
                           }
                        }

                        return (
                          <tr key={`${item.id}-${rowOpt.mpn}`} className={`transition-colors group ${
                            isSelected ? (highMoqRatio && isOriginal ? 'bg-amber-50/20' : 'bg-white') : 'bg-slate-50/30 text-slate-400'
                          }`}>
                            <td className={`px-6 py-4 flex items-start gap-3 ${!isOriginal ? 'pl-14 relative' : ''}`}>
                              {!isOriginal && (
                                <div className="absolute left-6 top-0 bottom-1/2 w-4 border-l-2 border-b-2 border-slate-200 rounded-bl-lg"></div>
                              )}
                              
                              {hasAlternates ? (
                                <div className="flex items-center justify-center mt-1 mr-2 z-10">
                                  <input 
                                    type="radio" 
                                    checked={isSelected}
                                    onChange={() => handleMpnSelect(item.id, rowOpt.mpn)}
                                    className="w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-500 cursor-pointer"
                                  />
                                </div>
                              ) : null}

                              <div>
                                <div className={`font-semibold ${isSelected ? 'text-slate-800' : 'text-slate-500'}`}>
                                  {rowOpt.mpn} {!isOriginal && <span className="text-xs font-normal text-slate-400 ml-1">(Alt)</span>}
                                </div>
                                {highMoqRatio && isOriginal && (
                                  <div className={`mt-1 text-[10px] ${isSelected ? 'text-amber-600' : 'text-amber-600/50'} font-medium flex items-center gap-1`}>
                                    <AlertCircle className="w-3 h-3" /> High MOQ ({item.moqRatio?.toFixed(1)}x)
                                  </div>
                                )}
                              </div>
                            </td>

                            <td className="px-6 py-4">
                              <span className={`px-2.5 py-1 rounded-md font-medium ${isSelected ? 'bg-slate-100 text-slate-600' : 'bg-slate-100/50 text-slate-400'}`}>
                                {item.quantity}
                              </span>
                            </td>

                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1 items-start">
                                <span className={`px-2.5 py-1 rounded-md font-bold border ${
                                  isSelected 
                                    ? 'bg-blue-50 text-blue-700 border-blue-100' 
                                    : 'bg-slate-50 text-slate-500 border-slate-100'
                                }`}>
                                  {isSelected ? (item.newQty ?? item.quantity) : (rowOpt.newQty ?? item.quantity)}
                                </span>
                                {(isSelected ? item.moqUpdated : rowOpt.moqUpdated) && (
                                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${
                                    isSelected 
                                      ? 'text-amber-700 bg-amber-100 border-amber-200'
                                      : 'text-amber-700/50 bg-amber-50/50 border-amber-200/50'
                                  }`} title="Adjusted to meet Vendor MOQ">
                                    MOQ Applied
                                  </span>
                                )}
                              </div>
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
                              
                              {item.status === 'success' && validPrices.length > 0 && isSelected && (
                                <div className="relative">
                                  <select
                                    value={item.selectedProvider || ''}
                                    onChange={(e) => handleProviderChange(item.id, e.target.value)}
                                    className={`appearance-none w-full border font-medium py-2 pl-3 pr-8 rounded-lg outline-none transition-all cursor-pointer ${
                                      item.selectedProvider === item.prices.find(p => p.isWinner)?.provider
                                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800 focus:ring-2 focus:ring-emerald-500/20'
                                        : 'bg-white border-slate-200 text-slate-700 focus:ring-2 focus:ring-blue-500/20'
                                    }`}
                                  >
                                    {validPrices.map(p => (
                                      <option key={p.provider} value={p.provider}>
                                        {p.provider} {p.isWinner ? '✨ (Best)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                  <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                              )}

                              {item.status === 'success' && validPrices.length > 0 && !isSelected && (
                                <div className="text-slate-500 font-medium">
                                  {activeProvider || 'No provider'} {rowOpt.resultObj?.winner === activeProvider && '✨'}
                                </div>
                              )}

                              {item.status === 'success' && validPrices.length === 0 && (
                                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border ${
                                  isSelected 
                                    ? 'text-rose-600 bg-rose-50 border-rose-100'
                                    : 'text-rose-400 bg-rose-50/50 border-rose-100/50'
                                }`}>
                                  <AlertCircle className="w-3.5 h-3.5" /> No Stock
                                </span>
                              )}
                            </td>

                            <td className="px-6 py-4 text-right">
                              {item.status === 'success' && activeCost !== null ? (
                                <div className="flex flex-col items-end">
                                  <span className={`font-bold text-base ${isSelected ? 'text-slate-900' : 'text-slate-400'}`}>
                                    {currencySymbol}{activeCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </span>
                                  <span className={`text-[10px] font-medium uppercase tracking-wider ${isSelected ? 'text-slate-400' : 'text-slate-300'}`}>Total</span>
                                </div>
                              ) : (
                                <span className="text-slate-300 font-medium">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
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

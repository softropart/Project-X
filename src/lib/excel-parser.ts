import * as xlsx from 'xlsx';

export interface ParsedBomItem {
  id: string;
  mpn: string;
  quantity: number;
}

export async function parseExcelFile(file: File): Promise<ParsedBomItem[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) throw new Error("Failed to read file data");

        const workbook = xlsx.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // Parse to array of arrays to handle files with arbitrary metadata before headers
        const json: any[][] = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

        let headers: string[] = [];
        let headerRowIndex = -1;

        // Find the header row by looking for common columns like Quantity or S.NO or MPN
        for (let i = 0; i < Math.min(json.length, 50); i++) {
          const row = json[i];
          if (!row) continue;
          
          const rowStrings = row.map(cell => String(cell).toLowerCase().trim());
          if (
            rowStrings.includes('quantity') || 
            rowStrings.includes('qty') || 
            rowStrings.some(cell => cell.includes('manufacturer part number')) ||
            rowStrings.includes('s.no')
          ) {
            headerRowIndex = i;
            headers = rowStrings;
            break;
          }
        }

        if (headerRowIndex === -1) {
          throw new Error("Could not find a valid header row containing MPN or Quantity.");
        }

        // Identify column indices
        let mpnIdx = -1;
        let qtyIdx = -1;

        for (let i = 0; i < headers.length; i++) {
          const header = headers[i];
          if (!header) continue;
          
          if (
            header.includes('manufacturer part number 1') || 
            header === 'mpn' || 
            header === 'manufacturer part number' ||
            header === 'part number'
          ) {
            mpnIdx = i;
          }
          if (header === 'quantity' || header === 'qty') {
            qtyIdx = i;
          }
        }

        if (mpnIdx === -1 || qtyIdx === -1) {
          throw new Error(`Missing required columns. Found MPN index: ${mpnIdx}, Qty index: ${qtyIdx}`);
        }

        const items: ParsedBomItem[] = [];

        // Parse data rows
        for (let i = headerRowIndex + 1; i < json.length; i++) {
          const row = json[i];
          if (!row || row.length === 0) continue;

          const mpn = row[mpnIdx];
          const qtyStr = row[qtyIdx];
          
          if (!mpn) continue; // Skip empty rows

          const quantity = parseInt(String(qtyStr), 10);
          
          if (!isNaN(quantity) && quantity > 0) {
            items.push({
              id: `item-${i}`,
              mpn: String(mpn).trim(),
              quantity,
            });
          }
        }

        resolve(items);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => {
      reject(error);
    };

    reader.readAsArrayBuffer(file);
  });
}

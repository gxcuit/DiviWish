import fs from 'node:fs/promises';
import {FileBlob, SpreadsheetFile, Workbook} from '@oai/artifact-tool';

const [path, dataPath] = process.argv.slice(2);
const records = JSON.parse(await fs.readFile(dataPath, 'utf8'));
const hasHistory = records.some(r => r.percentile_history);
const source = await SpreadsheetFile.importXlsx(await FileBlob.load(path));
// A calculation-only workbook avoids reserializing legacy WPS/Excel objects.
// The Python merger copies just the affected cells back into the original ZIP.
const wb = Workbook.create();
for (const name of ['股票数据','港股数据']) {
  const src = source.worksheets.getItem(name);
  const dest = wb.worksheets.add(name);
  const area = src.getUsedRange();
  const values = area.values;
  const formulas = area.formulas;
  if (name==='股票数据') for (const row of values) for (let c=14;c<Math.min(row.length,19);c++) row[c]=null;
  dest.getRangeByIndexes(0,0,values.length,values[0].length).values = values;
  for (let r=0;r<formulas.length;r++) for (let c=0;c<formulas[r].length;c++) {
    if (!(name==='股票数据' && c>=14 && c<=18) && typeof formulas[r][c] === 'string' && formulas[r][c].startsWith('='))
      dest.getRangeByIndexes(r,c,1,1).formulas = [[formulas[r][c]]];
  }
  dest.getUsedRange().format.font = {name:'Microsoft YaHei',size:11};
  dest.getUsedRange().format.rowHeight = 24;
  dest.getRangeByIndexes(0,0,1,values[0].length).format.font = {name:'Microsoft YaHei',size:11,bold:true};
}
const sheet = wb.worksheets.getItem('股票数据');
const outDir = dataPath.replace(/[/\\][^/\\]+$/, '');
await fs.writeFile(`${outDir}/rolling_before.png`, new Uint8Array(await (await wb.render({sheetName:'股票数据', range:'J1:M8', scale:1.5})).arrayBuffer()));
sheet.getRange('M1').copyFrom(sheet.getRange('G1'), 'all');
sheet.getRange('M1').values = [['最新滚动年度股息率']];
sheet.getRange('M:M').format.columnWidth = 26;
sheet.getRange('E1:G1').values = [['最新年度每股股息', '分红实施确认', '最新股息率']];
sheet.getRange('N1').copyFrom(sheet.getRange('F1'), 'all');
sheet.getRange('N1').values = [['股息所属年度']];
sheet.getRange('E:E').format.columnWidth = 23;
sheet.getRange('G:G').format.columnWidth = 18;
sheet.getRange('N:N').format.columnWidth = 18;
sheet.getRange('J:J').format.columnWidth = 18;
sheet.getRange('K:K').format.columnWidth = 20;
const annualByCode = new Map();
for (const record of records) {
  const r = record.row;
  const annual = record.annual;
  if (record.year_start && record.year_start.status!=='preserved') {
    sheet.getRange(`J${r}`).values = [[record.year_start.price ?? null]];
  }
  sheet.getRange(`J${r}`).setNumberFormat('0.00');
  sheet.getRange(`K${r}`).formulas = [[`=IF(AND(ISNUMBER(D${r}),ISNUMBER(J${r})),IF(J${r}>0,D${r}/J${r}-1,"待核实"),"待核实")`]];
  sheet.getRange(`K${r}`).setNumberFormat('0.00%');
  sheet.getRange(`N${r}`).copyFrom(sheet.getRange(`F${r}`), 'all');
  sheet.getRange(`N${r}`).setNumberFormat('0');
  if (annual) {
    sheet.getRange(`E${r}:F${r}`).values = [[annual.total, annual.confirmed]];
    sheet.getRange(`N${r}`).values = [[annual.year]];
    annualByCode.set(record.code, annual.total);
  } else {
    // Preserve the previous amount on failure; mark its year/status unavailable.
    sheet.getRange(`F${r}`).values = [[0]];
    sheet.getRange(`N${r}`).values = [['待核实']];
    annualByCode.set(record.code, null);
  }
  sheet.getRange(`G${r}`).formulas = [[`=IF(N${r}="待核实","待核实",IF(D${r}>0,E${r}/D${r},"待核实"))`]];
  sheet.getRange(`I${r}`).formulas = [[`=IF(N${r}="待核实","待核实",IF(H${r}>0,E${r}/H${r},"待核实"))`]];
  const cell = sheet.getRange(`M${record.row}`);
  cell.copyFrom(sheet.getRange(`G${record.row}`), 'all');
  if (record.error) cell.values = [['待核实']];
  else cell.formulas = [[`=IF(D${record.row}>0,${record.total}/D${record.row},"待核实")`]];
  cell.setNumberFormat('0.00%');
}
const hk = wb.worksheets.getItem('港股数据');
hk.getRange('F1').values = [['最新年度分红（RMB）']];
for (let r=2; r<=hk.getUsedRange().values.length; r++) {
  const code = String(hk.getRange(`C${r}`).values[0][0] ?? '').padStart(6,'0');
  if (annualByCode.has(code)) {
    hk.getRange(`F${r}`).values = [[annualByCode.get(code) ?? '待核实']];
    hk.getRange(`H${r}`).formulas = [[`=IF(ISNUMBER(F${r}),F${r}/E${r},"待核实")`]];
    hk.getRange(`I${r}`).formulas = [[`=IF(ISNUMBER(F${r}),F${r}/(D${r}*$O$1),"待核实")`]];
    hk.getRange(`J${r}`).formulas = [[`=IF(ISNUMBER(F${r}),I${r}*0.9,"待核实")`]];
    hk.getRange(`K${r}`).formulas = [[`=IF(ISNUMBER(F${r}),I${r}*L${r},"待核实")`]];
  }
}
if (hasHistory) {
  const history = wb.worksheets.add('股息率历史');
  history.showGridLines = false;
  history.freezePanes.freezeRows(5);
  history.getRange('A1').values = [['近5年历史股息率']];
  history.getRange('A2').values = [['分红公告后下一交易日生效；每个历史日按当时最新完整年度股息计算。']];
  history.getRange('A3').values = [['来源：腾讯不复权日线、东财分红预案日期；按现存方案回溯，非历史方案版本快照。']];
  sheet.getRange('O1').copyFrom(sheet.getRange('G1'),'all');
  sheet.getRange('O1').values = [['股息率百分位（近5年）']];
  sheet.getRange('O:O').format.columnWidth = 28;
  for (const [column,label,width] of [['P','60分位股息率（近5年）',25],['Q','60分位对应股价（元）',23],
                                      ['R','90分位股息率（近5年）',25],['S','90分位对应股价（元）',23]]) {
    sheet.getRange(`${column}1`).copyFrom(sheet.getRange('G1'),'all');
    sheet.getRange(`${column}1`).values = [[label]];
    sheet.getRange(`${column}:${column}`).format.columnWidth = width;
  }
  history.getRange('A4').values = [['分位取升序第ceil(p×N)项；对应股价=最新年度股息÷分位股息率。逐日明细见 dividend_percentiles.json。']];
  history.getRange('A5:K5').values = [['股票代码','股票名称','样本开始','样本结束','评估股息率','不高于当前的天数','有效交易日数',
                                     '60分位历史股息率','90分位历史股息率','评估年度每股股息','评估股息年度']];
  for (const [index,record] of records.entries()) {
    const data = record.percentile_history;
    const hrow=index+6;
    const cell = sheet.getRange(`O${record.row}`);
    cell.copyFrom(sheet.getRange(`G${record.row}`),'all');
    cell.setNumberFormat('0.00%');
    for (const column of ['P','Q','R','S']) {
      const target=sheet.getRange(`${column}${record.row}`);
      target.copyFrom(sheet.getRange(`${['P','R'].includes(column)?'G':'I'}${record.row}`),'all');
      target.setNumberFormat(['P','R'].includes(column)?'0.00%':'0.00');
    }
    if (!data || data.error || !data.samples?.length || !record.annual) {
      cell.values = [['待核实']];
      sheet.getRange(`P${record.row}:S${record.row}`).values = [['待核实','待核实','待核实','待核实']];
      history.getRange(`A${hrow}:B${hrow}`).values = [[record.code,record.name]];
      continue;
    }
    const current = sheet.getRange(`G${record.row}`).values[0][0];
    const count=data.samples.filter(s=>(s.yield??s.annual/s.close)<=current+1E-12).length;
    const serial=d=>Math.floor(Date.parse(`${d}T00:00:00Z`)/86400000)+25569;
    history.getRange(`A${hrow}:G${hrow}`).values = [[record.code,record.name,serial(data.start),serial(data.end),current,count,data.samples.length]];
    const sorted=data.samples.map(s=>s.yield??s.annual/s.close).sort((a,b)=>a-b);
    if (sorted.some(y=>!Number.isFinite(y)||y<0)) throw new Error(`历史股息率无效: ${record.code}`);
    const q60=sorted[Math.ceil(.6*sorted.length)-1],q90=sorted[Math.ceil(.9*sorted.length)-1];
    history.getRange(`H${hrow}:K${hrow}`).values = [[q60,q90,record.annual.total,record.annual.year]];
    const r=record.row;
    for (const [yieldCol,priceCol,helperCol] of [['P','Q','H'],['R','S','I']]) {
      sheet.getRange(`${yieldCol}${r}`).formulas = [[`=IF(AND(ISNUMBER(E${r}),ISNUMBER(N${r})),IF(AND(N${r}='股息率历史'!K${hrow},ABS(E${r}-'股息率历史'!J${hrow})<1E-10),'股息率历史'!${helperCol}${hrow},"请更新"),"待核实")`]];
      sheet.getRange(`${priceCol}${r}`).formulas = [[`=IF(ISNUMBER(${yieldCol}${r}),IF(${yieldCol}${r}>0,E${r}/${yieldCol}${r},"不适用"),${yieldCol}${r})`]];
    }
    cell.formulas = [[`=IF(ISNUMBER(G${record.row}),IF(ABS(G${record.row}-'股息率历史'!E${hrow})<1E-10,'股息率历史'!F${hrow}/'股息率历史'!G${hrow},"请更新"),"待核实")`]];
  }
  history.getUsedRange().format.font = {name:'Microsoft YaHei',size:10};
  history.getUsedRange().format.columnWidth = 21;
  history.getUsedRange().format.rowHeight = 20;
  history.getRange('A5:K5').format.font = {name:'Microsoft YaHei',size:10,bold:true};
  history.getRange('A5:K5').format.fill = '#E8EDF2';
  history.getRange(`A6:A${records.length+5}`).setNumberFormat('@');
  history.getRange(`C6:D${records.length+5}`).setNumberFormat('yyyy-mm-dd');
  history.getRange(`E6:E${records.length+5}`).setNumberFormat('0.00%');
  history.getRange(`F6:G${records.length+5}`).setNumberFormat('0');
  history.getRange(`H6:I${records.length+5}`).setNumberFormat('0.00%');
  history.getRange(`J6:J${records.length+5}`).setNumberFormat('0.0000');
  history.getRange(`K6:K${records.length+5}`).setNumberFormat('0');
}
wb.recalculate();
for (const record of records) {
  const r=record.row,price=sheet.getRange(`D${r}`).values[0][0],base=sheet.getRange(`J${r}`).values[0][0];
  const actual=sheet.getRange(`K${r}`).values[0][0];
  const valid=typeof price==='number'&&typeof base==='number'&&base>0;
  if (valid ? typeof actual!=='number'||Math.abs(actual-(price/base-1))>1E-10 : actual!=='待核实')
    throw new Error(`年内涨跌计算不一致: ${record.code}`);
}
const yearProbe=records.find(r=>typeof sheet.getRange(`J${r.row}`).values[0][0]==='number' &&
                              sheet.getRange(`J${r.row}`).values[0][0]>0);
if (yearProbe) {
  const priceCell=sheet.getRange(`D${yearProbe.row}`),baseCell=sheet.getRange(`J${yearProbe.row}`);
  const savedPrice=priceCell.values,savedBase=baseCell.values;
  priceCell.values=[[savedPrice[0][0]*1.1]];
  wb.recalculate();
  if (Math.abs(sheet.getRange(`K${yearProbe.row}`).values[0][0]-(savedPrice[0][0]*1.1/savedBase[0][0]-1))>1E-10)
    throw new Error('年内涨跌没有随价格变化重算');
  priceCell.values=savedPrice;
  baseCell.values=[[0]];
  wb.recalculate();
  if (sheet.getRange(`K${yearProbe.row}`).values[0][0]!=='待核实') throw new Error('年初价为零时未正确提示');
  baseCell.values=savedBase;
  wb.recalculate();
}
await fs.writeFile(`${outDir}/year_start_preview.png`,new Uint8Array(await (await wb.render({sheetName:'股票数据',range:'J1:K20',scale:1.5})).arrayBuffer()));
console.log((await wb.inspect({kind:'table', range:'股票数据!L22:M26', include:'values,formulas', tableMaxRows:5, tableMaxCols:2})).ndjson);
console.log((await wb.inspect({kind:'match', searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!', options:{useRegex:true,maxResults:10}, summary:'formula check'})).ndjson);
if (hasHistory) {
  console.log((await wb.inspect({kind:'table',range:'股票数据!M22:O26',include:'values,formulas',tableMaxRows:5,tableMaxCols:3})).ndjson);
  for (const record of records) {
    const data = record.percentile_history;
    if (data && !data.error) {
      const actual = sheet.getRange(`O${record.row}`).values[0][0];
      if (typeof actual !== 'number' || Math.abs(actual-data.percentile)>1e-10)
        throw new Error(`历史百分位计算不一致: ${record.code} ${actual} / ${data.percentile}`);
      const sorted=data.samples.map(s=>s.yield??s.annual/s.close).sort((a,b)=>a-b);
      for (const [p,yieldCol,priceCol] of [[.6,'P','Q'],[.9,'R','S']]) {
        const expected=sorted[Math.ceil(p*sorted.length)-1];
        const threshold=sheet.getRange(`${yieldCol}${record.row}`).values[0][0];
        const price=sheet.getRange(`${priceCol}${record.row}`).values[0][0];
        if (typeof threshold!=='number'||Math.abs(threshold-expected)>1E-12 ||
            (expected>0 && (typeof price!=='number'||Math.abs(price-record.annual.total/expected)>1E-8)) ||
            (expected===0 && price!=='不适用')) throw new Error(`分位股息率/对应股价不一致: ${record.code} ${p}`);
      }
    }
  }
  // Check that the new formula responds to current yield changes, then restore.
  const probe = records.find(r=>r.percentile_history && !r.percentile_history.error);
  if (probe) {
    const cell = sheet.getRange(`G${probe.row}`);
    const saved = cell.formulas;
    cell.values = [[10]];
    wb.recalculate();
    if (sheet.getRange(`O${probe.row}`).values[0][0] !== '请更新') throw new Error('百分位未识别股息率变动');
    cell.formulas = saved;
    wb.recalculate();
    const annual=sheet.getRange(`E${probe.row}`),oldAnnual=annual.values;
    annual.values=[[oldAnnual[0][0]+1]];
    wb.recalculate();
    for (const c of ['P','Q','R','S']) if (sheet.getRange(`${c}${probe.row}`).values[0][0]!=='请更新')
      throw new Error('分位未识别年度分红变动');
    annual.values=oldAnnual;
    wb.recalculate();
    const threshold=sheet.getRange(`P${probe.row}`),savedThreshold=threshold.formulas;
    threshold.values=[[.1]];
    wb.recalculate();
    if (Math.abs(sheet.getRange(`Q${probe.row}`).values[0][0]-oldAnnual[0][0]/.1)>1E-8)
      throw new Error('分位对应股价未随股息率重算');
    threshold.values=[[0]];
    wb.recalculate();
    if (sheet.getRange(`Q${probe.row}`).values[0][0]!=='不适用') throw new Error('零股息率没有正确处理');
    threshold.formulas=savedThreshold;
    wb.recalculate();
  }
  console.log((await wb.inspect({kind:'table',range:'股票数据!P1:S8',include:'values,formulas',tableMaxRows:8,tableMaxCols:4})).ndjson);
  console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',options:{useRegex:true,maxResults:20},summary:'分位列最终公式检查'})).ndjson);
  await fs.writeFile(`${outDir}/quantile_preview.png`,new Uint8Array(await (await wb.render({sheetName:'股票数据',range:'O1:S9',scale:1.5})).arrayBuffer()));
  await fs.writeFile(`${outDir}/percentile_preview.png`,new Uint8Array(await (await wb.render({sheetName:'股票数据',range:'M1:O9',scale:1.5})).arrayBuffer()));
  await fs.writeFile(`${outDir}/history_preview.png`,new Uint8Array(await (await wb.render({sheetName:'股息率历史',range:'A5:G12',scale:1.5})).arrayBuffer()));
}
await fs.writeFile(`${outDir}/rolling_preview.png`, new Uint8Array(await (await wb.render({sheetName:'股票数据', range:'J20:M26', scale:1.5})).arrayBuffer()));
await fs.writeFile(`${outDir}/rolling_header.png`, new Uint8Array(await (await wb.render({sheetName:'股票数据', range:'J1:M5', scale:1.5})).arrayBuffer()));
await fs.writeFile(`${outDir}/latest_annual_preview.png`, new Uint8Array(await (await wb.render({sheetName:'股票数据', range:'D1:I7', scale:1.5})).arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(`${outDir}/rolling_authored.xlsx`);

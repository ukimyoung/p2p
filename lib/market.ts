export type Asset = 'ETH' | 'WBTC';
export type Side = 'buy' | 'sell';
export type AdSort = 'best_price' | 'available_desc' | 'newest';
export const orderStateLabel: Record<string,string> = {
  RESERVED:'광고주 응답 대기', ACCEPTED:'광고주 수락 · 데모 대기', DECLINED:'광고주 거절',
  CANCELLED:'취소', EXPIRED:'만료', CHAIN_SIGNING:'로컬 체인 서명 대기',
  OPEN_PENDING:'에스크로 개설 확인 대기', OPEN:'Maker 예치 대기', MAKER_FUNDED:'Taker 예치 대기',
  SETTLED:'로컬 체인 교환 완료', REFUNDED:'Maker 환불 완료', SIGNATURE_EXPIRED:'서명 만료 · 재고 복구',
};
export type OrderStatusFilter = 'all' | 'active' | 'completed' | 'closed';
export const orderStatusFilters: {value:OrderStatusFilter;label:string}[] = [
  {value:'all',label:'전체'},
  {value:'active',label:'진행 중'},
  {value:'completed',label:'완료'},
  {value:'closed',label:'종료·환불'},
];
export function orderStatusGroup(state:string):Exclude<OrderStatusFilter,'all'> {
  if(state==='SETTLED')return 'completed';
  if(['DECLINED','CANCELLED','EXPIRED','REFUNDED','SIGNATURE_EXPIRED'].includes(state))return 'closed';
  return 'active';
}
export function filterOrdersByStatus<T extends {state:string}>(orders:T[],filter:OrderStatusFilter):T[] {
  return filter==='all'?orders:orders.filter(order=>orderStatusGroup(order.state)===filter);
}
export type Ad = {
  id: string; maker: string; initials: string;
  side: Side; asset: Asset; price: string; available: string; min: string; max: string; minutes: number;
  total?: string; makerAddress?: string; version?: number; status?: string; demo?: boolean; expiresAt?: number;
  createdAt?: number; createdOrder?: number;
};
export const ads: Ad[] = [
  {id:'eth-01',maker:'Seoul Node',initials:'SN',side:'buy',asset:'ETH',price:'2645.50',available:'12.50',min:'100',max:'10000',minutes:15},
  {id:'eth-02',maker:'Blue Whale',initials:'BW',side:'buy',asset:'ETH',price:'2648.00',available:'8.20',min:'50',max:'5000',minutes:10},
  {id:'eth-03',maker:'Onchain Garden',initials:'OG',side:'buy',asset:'ETH',price:'2651.25',available:'24.00',min:'500',max:'20000',minutes:15},
  {id:'btc-01',maker:'Block Harbor',initials:'BH',side:'buy',asset:'WBTC',price:'68250.00',available:'1.40',min:'100',max:'25000',minutes:15},
  {id:'sell-01',maker:'Ether Studio',initials:'ES',side:'sell',asset:'ETH',price:'2638.00',available:'16.00',min:'100',max:'15000',minutes:15},
  {id:'sell-02',maker:'Block Harbor',initials:'BH',side:'sell',asset:'WBTC',price:'68100.00',available:'0.80',min:'100',max:'20000',minutes:15},
];
export function units(value: string, decimals = 6): bigint {
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > decimals) throw new Error(`소수점 ${decimals}자리까지의 양수를 입력하세요.`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}
export function formatUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? '.' + fraction : ''}`;
}
// Demo policy: 0.1% fee in USDC, rounded upward to one micro-USDC.
export function quote(ad: Ad, input: string) {
  const amount = units(input);
  if (amount === 0n || amount < units(ad.min) || amount > units(ad.max)) throw new Error(`거래 한도는 ${ad.min}–${ad.max} USDC입니다.`);
  const decimals = ad.asset === 'ETH' ? 18 : 8;
  const assetAmount = amount * 10n ** BigInt(decimals) / units(ad.price);
  if (assetAmount === 0n || assetAmount > units(ad.available, decimals)) throw new Error('광고의 거래 가능 수량을 초과했습니다.');
  const fee = (amount + 999n) / 1000n;
  return {assetAmount: formatUnits(assetAmount, decimals), fee: formatUnits(fee, 6), total: formatUnits(amount + fee, 6), proceeds: formatUnits(amount - fee, 6)};
}
export function filterAds(side: Side, asset: Asset, amount: string, source: Ad[] = ads, sort: AdSort = 'best_price') {
  const found = source.filter(ad => {
    if (ad.side !== side || ad.asset !== asset) return false;
    if (!amount) return true;
    try { quote(ad, amount); return true; } catch { return false; }
  });
  const compare=(a:bigint,b:bigint)=>a<b?-1:a>b?1:0;
  return found.sort((a,b)=>{
    if(sort==='newest') {
      const sequence=(b.createdOrder??0)-(a.createdOrder??0);
      if(sequence)return sequence;
      const timestamp=(b.createdAt??0)-(a.createdAt??0);
      if(timestamp)return timestamp;
    }
    if(sort==='available_desc') {
      const decimals=asset==='ETH'?18:8;
      const quantity=compare(units(b.available,decimals),units(a.available,decimals));
      if(quantity)return quantity;
    }
    return compare(units(a.price),units(b.price))*(side==='buy'?1:-1);
  });
}

import { orderStateLabel, type OrderStatusFilter } from './market';

export type Language='ko'|'en';
const englishStates:Record<string,string>={
  RESERVED:'Waiting for advertiser',ACCEPTED:'Accepted · demo pending',DECLINED:'Declined',
  CANCELLED:'Cancelled',EXPIRED:'Expired',CHAIN_SIGNING:'Signing',OPEN_PENDING:'Opening escrow',
  OPEN:'Waiting for maker deposit',MAKER_FUNDED:'Waiting for taker deposit',SETTLED:'Settled',
  REFUNDED:'Refunded',SIGNATURE_EXPIRED:'Signature expired',
};
const englishFilters:Record<OrderStatusFilter,string>={all:'All',active:'Active',completed:'Completed',closed:'Closed'};

export const stateName=(state:string,language:Language)=>language==='ko'?(orderStateLabel[state]||state):(englishStates[state]||state);
export const filterName=(filter:OrderStatusFilter,language:Language)=>language==='ko'?({all:'전체',active:'진행 중',completed:'완료',closed:'종료·환불'}[filter]):englishFilters[filter];

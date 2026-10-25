'use client';
import {filterOrdersByStatus, OrderStatusFilter, orderStatusFilters} from '../lib/market';
import {filterName} from '../lib/i18n';
import {useLanguage} from './language-provider';

export default function OrderStatusFilterBar({orders,value,onChange}:{orders:{state:string}[];value:OrderStatusFilter;onChange:(value:OrderStatusFilter)=>void}) {
  const {t,language}=useLanguage();
  return <div className="order-status-filters" role="group" aria-label={t('거래 상태 필터','Order status filter')}>
    {orderStatusFilters.map(filter=><button key={filter.value} type="button" aria-pressed={value===filter.value} onClick={()=>onChange(filter.value)}>{filterName(filter.value,language)} <span>{filterOrdersByStatus(orders,filter.value).length}</span></button>)}
  </div>;
}

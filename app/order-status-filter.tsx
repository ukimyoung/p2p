import {filterOrdersByStatus, OrderStatusFilter, orderStatusFilters} from '../lib/market';

export default function OrderStatusFilterBar({orders,value,onChange}:{orders:{state:string}[];value:OrderStatusFilter;onChange:(value:OrderStatusFilter)=>void}) {
  return <div className="order-status-filters" role="group" aria-label="거래 상태 필터">
    {orderStatusFilters.map(filter=><button key={filter.value} type="button" aria-pressed={value===filter.value} onClick={()=>onChange(filter.value)}>{filter.label} <span>{filterOrdersByStatus(orders,filter.value).length}</span></button>)}
  </div>;
}

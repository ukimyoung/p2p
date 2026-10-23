import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ads, filterAds, filterOrdersByStatus, orderStatusFilters, quote, units} from '../lib/market';
test('USDC is parsed exactly and rejects unsafe inputs',()=>{
 assert.equal(units('100.000001'),100000001n);
 for(const value of ['-1','1e3','NaN','','0.0000001']) assert.throws(()=>units(value));
});
test('quote respects limits, exact division and fee rounding',()=>{
 const ad={...ads[0],price:'2000',min:'0.000001'};
 assert.deepEqual(quote(ad,'100'),{assetAmount:'0.05',fee:'0.1',total:'100.1',proceeds:'99.9'});
 assert.equal(quote(ad,'0.000001').fee,'0.000001');
 for(const value of ['0','10001','-1']) assert.throws(()=>quote(ad,value));
 assert.throws(()=>quote({...ad,available:'0.001'},'100'));
});
test('buy/sell price ordering and amount filters match the visible terms',()=>{
 assert.equal(filterAds('buy','ETH','')[0].id,'eth-01');
 assert.equal(filterAds('buy','ETH','50')[0].id,'eth-02');
 assert.equal(filterAds('buy','ETH','999999').length,0);
 assert.equal(filterAds('buy','ETH','invalid').length,0);
 assert.ok(filterAds('sell','WBTC','').every(ad=>ad.side==='sell' && ad.asset==='WBTC'));
 assert.ok(ads.every(ad=>!('completion' in ad)&&!('trades' in ad)));
});
test('quantity sorting uses exact asset units and keeps favorable price as tie-breaker',()=>{
 assert.deepEqual(filterAds('buy','ETH','',ads,'available_desc').map(ad=>ad.id),['eth-03','eth-01','eth-02']);
 const source=[
  {...ads[0],id:'lower-quantity',available:'1.000000000000000001',price:'2400'},
  {...ads[0],id:'higher-price',available:'1.000000000000000002',price:'2500'},
  {...ads[0],id:'lower-price',available:'1.000000000000000002',price:'2300'},
 ];
 assert.deepEqual(filterAds('buy','ETH','',source,'available_desc').map(ad=>ad.id),['lower-price','higher-price','lower-quantity']);
 assert.deepEqual(filterAds('buy','ETH','',source,'best_price').map(ad=>ad.id),['lower-price','lower-quantity','higher-price']);
});
test('newest sorting follows registration order across timestamp ties and clock changes',()=>{
 const source=[
  {...ads[0],id:'legacy',createdOrder:2},
  {...ads[0],id:'older',createdAt:1000,createdOrder:3},
  {...ads[0],id:'same-time-first',createdAt:2000,createdOrder:4},
  {...ads[0],id:'same-time-last',createdAt:2000,createdOrder:5},
  {...ads[0],id:'clock-moved-back',createdAt:1500,createdOrder:6},
 ];
 assert.deepEqual(filterAds('buy','ETH','',source,'newest').map(ad=>ad.id),['clock-moved-back','same-time-last','same-time-first','older','legacy']);
});
test('order filters distinguish active, settled, and terminal outcomes',()=>{
 const orders=['RESERVED','ACCEPTED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED','SETTLED','DECLINED','CANCELLED','EXPIRED','REFUNDED','SIGNATURE_EXPIRED'].map(state=>({state}));
 assert.deepEqual(orderStatusFilters.map(filter=>filterOrdersByStatus(orders,filter.value).length),[12,6,1,5]);
 assert.deepEqual(filterOrdersByStatus(orders,'completed').map(order=>order.state),['SETTLED']);
 assert.deepEqual(filterOrdersByStatus(orders,'closed').map(order=>order.state),['DECLINED','CANCELLED','EXPIRED','REFUNDED','SIGNATURE_EXPIRED']);
});

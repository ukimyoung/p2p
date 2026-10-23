import type { Address, Hex } from 'viem';

export type ChainTerms = {
  orderId: Hex; maker: Address; taker: Address;
  makerNonce: string; takerNonce: string;
  makerToken: Address; takerToken: Address;
  makerDeposit: string; takerDeposit: string;
  makerReceive: string; takerReceive: string;
  fee: string; signatureDeadline: string;
};

const termsComponents = [
  {name:'orderId',type:'bytes32'}, {name:'maker',type:'address'}, {name:'taker',type:'address'},
  {name:'makerNonce',type:'uint256'}, {name:'takerNonce',type:'uint256'},
  {name:'makerToken',type:'address'}, {name:'takerToken',type:'address'},
  {name:'makerDeposit',type:'uint256'}, {name:'takerDeposit',type:'uint256'},
  {name:'makerReceive',type:'uint256'}, {name:'takerReceive',type:'uint256'},
  {name:'fee',type:'uint256'}, {name:'signatureDeadline',type:'uint64'},
] as const;

export const escrowAbi = [
  {type:'function',name:'openOrder',stateMutability:'nonpayable',inputs:[{name:'t',type:'tuple',components:termsComponents},{name:'makerSignature',type:'bytes'},{name:'takerSignature',type:'bytes'}],outputs:[]},
  {type:'function',name:'depositMaker',stateMutability:'nonpayable',inputs:[{name:'orderId',type:'bytes32'}],outputs:[]},
  {type:'function',name:'depositTaker',stateMutability:'nonpayable',inputs:[{name:'orderId',type:'bytes32'}],outputs:[]},
  {type:'function',name:'cancelUnfunded',stateMutability:'nonpayable',inputs:[{name:'orderId',type:'bytes32'}],outputs:[]},
  {type:'function',name:'expireUnfunded',stateMutability:'nonpayable',inputs:[{name:'orderId',type:'bytes32'}],outputs:[]},
  {type:'function',name:'refundMaker',stateMutability:'nonpayable',inputs:[{name:'orderId',type:'bytes32'}],outputs:[]},
  {type:'function',name:'getOrder',stateMutability:'view',inputs:[{name:'orderId',type:'bytes32'}],outputs:[{name:'order',type:'tuple',components:[{name:'terms',type:'tuple',components:termsComponents},{name:'state',type:'uint8'},{name:'makerDeadline',type:'uint64'},{name:'takerDeadline',type:'uint64'}]}]},
  {type:'function',name:'quoteToken',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'allowedToken',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]},
  {type:'event',name:'OrderOpened',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'maker',type:'address',indexed:true},{name:'taker',type:'address',indexed:true},{name:'termsHash',type:'bytes32',indexed:false},{name:'makerDeadline',type:'uint64',indexed:false}]},
  {type:'event',name:'MakerDeposited',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'token',type:'address',indexed:false},{name:'amount',type:'uint256',indexed:false},{name:'takerDeadline',type:'uint64',indexed:false}]},
  {type:'event',name:'OrderSettled',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'makerToken',type:'address',indexed:false},{name:'takerToken',type:'address',indexed:false},{name:'makerReceive',type:'uint256',indexed:false},{name:'takerReceive',type:'uint256',indexed:false},{name:'fee',type:'uint256',indexed:false}]},
  {type:'event',name:'OrderCancelled',inputs:[{name:'orderId',type:'bytes32',indexed:true}]},
  {type:'event',name:'OrderExpired',inputs:[{name:'orderId',type:'bytes32',indexed:true}]},
  {type:'event',name:'MakerRefunded',inputs:[{name:'orderId',type:'bytes32',indexed:true},{name:'token',type:'address',indexed:false},{name:'amount',type:'uint256',indexed:false}]},
] as const;

export const erc20Abi = [
  {type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]},
  {type:'function',name:'allowance',stateMutability:'view',inputs:[{type:'address'},{type:'address'}],outputs:[{type:'uint256'}]},
  {type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[{type:'bool'}]},
] as const;

export const termsTypes = {Terms:termsComponents.map(({name,type})=>({name,type}))};
export function typedOrder(chainId:number,contract:Address,terms:ChainTerms) {
  return {domain:{name:'PeerEscrow',version:'1',chainId,verifyingContract:contract},types:termsTypes,primaryType:'Terms' as const,message:contractTerms(terms)};
}
export function contractTerms(t:ChainTerms) {
  return {...t,makerNonce:BigInt(t.makerNonce),takerNonce:BigInt(t.takerNonce),makerDeposit:BigInt(t.makerDeposit),takerDeposit:BigInt(t.takerDeposit),makerReceive:BigInt(t.makerReceive),takerReceive:BigInt(t.takerReceive),fee:BigInt(t.fee),signatureDeadline:BigInt(t.signatureDeadline)};
}

export function illustrativeQuote(gross,networkCost=0n) {
  if(typeof gross!=='bigint'||typeof networkCost!=='bigint'||gross<0n||networkCost<0n) throw new RangeError('Use nonnegative integer lamports');
  const fee=gross*1800n/10000n;
  return {gross, fee, networkCost, net:gross-fee-networkCost};
}

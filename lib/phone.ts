import { getCountries, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

const countries=new Set<string>(getCountries());

export function normalizePhone(country:unknown,raw:unknown) {
  if(typeof country!=='string'||!countries.has(country)||typeof raw!=='string'||raw.length>40) return undefined;
  const phone=parsePhoneNumberFromString(raw,country as CountryCode);
  if(!phone?.isValid()||phone.country!==country) return undefined;
  return {countryCode:country,phoneE164:phone.number};
}

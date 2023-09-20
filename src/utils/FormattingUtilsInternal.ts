import assert from "assert";
import BigNumber from "bignumber.js";
import Web3 from "web3";

type BN = ReturnType<Web3["utils"]["toBN"]>;

const { fromWei, toBN } = Web3.utils;

// Apply settings to BigNumber.js library.
// Note: ROUNDING_MODE is set to round ceiling so we send at least enough collateral to create the requested tokens.
// Note: RANGE is set to 500 so values don't overflow to infinity until they hit +-1e500.
// Note: EXPONENTIAL_AT is set to 500 to keep BigNumber from using exponential notation until the numbers hit
// +-1e500.
BigNumber.set({ ROUNDING_MODE: 2, RANGE: 500, EXPONENTIAL_AT: 500 });

// formatWei converts a string or BN instance from Wei to Ether, e.g., 1e19 -> 10.
export const formatWei = (num: string | BN): string => {
  // Web3's `fromWei` function doesn't work on BN objects in minified mode (e.g.,
  // `web3.utils.isBN(web3.utils.fromBN("5"))` is false), so we use a workaround where we always pass in strings.
  // See https://github.com/ethereum/web3.js/issues/1777.
  return fromWei(num.toString());
};

// Formats the input to round to decimalPlaces number of decimals if the number has a magnitude larger than 1 and fixes
// precision to minPrecision if the number has a magnitude less than 1.
export const formatWithMaxDecimals = (
  num: number | string,
  decimalPlaces: number,
  minPrecision: number,
  roundUp: boolean,
  showSign: boolean
): string => {
  if (roundUp) {
    BigNumber.set({ ROUNDING_MODE: BigNumber.ROUND_UP });
  } else {
    BigNumber.set({ ROUNDING_MODE: BigNumber.ROUND_DOWN });
  }

  const fullPrecisionFloat = new BigNumber(num);
  const positiveSign = showSign && fullPrecisionFloat.gt(0) ? "+" : "";
  let fixedPrecisionFloat;
  // Convert back to BN to truncate any trailing 0s that the toFixed() output would print. If the number is equal to or larger than
  // 1 then truncate to `decimalPlaces` number of decimal places. EG 999.999 -> 999.99 with decimalPlaces=2 If the number
  // is less than 1 then truncate to minPrecision precision. EG: 0.0022183471 -> 0.002218 with minPrecision=4
  if (fullPrecisionFloat.abs().gte(new BigNumber(1))) {
    fixedPrecisionFloat = new BigNumber(fullPrecisionFloat).toFixed(decimalPlaces).toString();
  } else {
    fixedPrecisionFloat = new BigNumber(fullPrecisionFloat).toPrecision(minPrecision).toString();
  }
  // This puts commas in the thousands places, but only before the decimal point.
  const fixedPrecisionFloatParts = fixedPrecisionFloat.split(".");
  fixedPrecisionFloatParts[0] = fixedPrecisionFloatParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return positiveSign + fixedPrecisionFloatParts.join(".");
};

export const createFormatFunction = (
  numDisplayedDecimals: number,
  minDisplayedPrecision: number,
  showSign = false,
  decimals = 18
) => {
  return (valInWei: string | BN): string =>
    formatWithMaxDecimals(
      formatWei(ConvertDecimals(decimals, 18)(valInWei)),
      numDisplayedDecimals,
      minDisplayedPrecision,
      false,
      showSign
    );
};

// Take an amount based on fromDecimals and convert it to an amount based on toDecimals. For example 100 usdt = 100e6,
// with 6 decimals. If you wanted to convert this to a base 18 decimals you would get:
// convertDecimals(6,18)(100000000)  => 100000000000000000000 = 100e18.
// Returns a BigNumber you will need to call toString on
// fromDecimals: number - decimal value of amount
// toDecimals: number - decimal value to convert to
// web3: web3 object to get a big number function.
// return => (amount:string)=>BN
export const ConvertDecimals = (fromDecimals: number, toDecimals: number): ((amountIn: string | number | BN) => BN) => {
  assert(fromDecimals >= 0, "requires fromDecimals as an integer >= 0");
  assert(toDecimals >= 0, "requires toDecimals as an integer >= 0");
  // amount: string, BN, number - integer amount in fromDecimals smallest unit that want to convert toDecimals
  // returns: BN with toDecimals in smallest unit
  return (amountIn: string | number | BN) => {
    const amount = toBN(amountIn.toString());
    if (amount.isZero()) return amount;
    const diff = fromDecimals - toDecimals;
    if (diff == 0) return amount;
    if (diff > 0) return amount.div(toBN("10").pow(toBN(diff.toString())));
    return amount.mul(toBN("10").pow(toBN((-1 * diff).toString())));
  };
};

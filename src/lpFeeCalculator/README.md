# LP Fee Calculator

Calculates LP fee percentages when doing a transfer.

## Usage

See tests for more documentation: [LP Fee Calculator Test]("./lpFeeCalculator.test.ts")

```ts
import * as across from "@across/sdk-v2"

const { calculateApyFromUtilization, calculateRealizedLpFeePct } = across.lpFeeCalculator

// sample interest rate model.
const rateModel = { UBar: toBNWei("0.65"), R0: toBNWei("0.00"), R1: toBNWei("0.08"), R2: toBNWei("1.00") }

// Each interval contains the utilization at pointA (before deposit), the
// utilization at pointB (after the deposit), expected APY rate and the expected weekly rate.
const interval = { utilA: toBNWei("0"), utilB: toBNWei("0.01"), apy: "615384615384600", wpy: "11830749673498" }

// Calculate the realized yearly LP Fee APY Percent for a given rate model, utilization before and after the deposit.
const apyFeePct = calculateApyFromUtilization(rateModel, interval.utilA, interval.utilB)
assert.equal(apyFeePct.toString(), interval.apy)

const realizedLpFeePct = calculateRealizedLpFeePct(rateModel, interval.utilA, interval.utilB).toString()
assert.equal(realizedLpFeePct.toString(), interval.wpy)
```
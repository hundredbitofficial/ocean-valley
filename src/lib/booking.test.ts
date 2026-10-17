import { describe, expect, it } from "vitest";
import { assertBookingTransition, calculateQuote, canTransitionBooking } from "./booking";
import { formatRupees } from "./site";

describe("formatRupees", () => {
  it("formats integer paise as rupees with paise precision", () => {
    expect(formatRupees(2_000)).toBe("₹20.00");
    expect(formatRupees(2_050)).toBe("₹20.50");
  });
});

describe("calculateQuote", () => {
  it("calculates add-ons, tax and percentage advance in paise", () => {
    expect(calculateQuote({
      servicePricePaise: 10_000,
      addonPricesPaise: [2_500],
      taxRateBasisPoints: 500,
      advanceType: "percentage",
      advanceValue: 2_500,
    })).toEqual({
      subtotalPaise: 12_500,
      discountPaise: 0,
      taxPaise: 625,
      totalPaise: 13_125,
      advanceDuePaise: 3_281,
      balanceDuePaise: 9_844,
    });
  });

  it("caps percentage coupon discount and fixed advance at the order total", () => {
    const quote = calculateQuote({
      servicePricePaise: 1_000,
      addonPricesPaise: [],
      taxRateBasisPoints: 0,
      advanceType: "fixed",
      advanceValue: 9_000,
      coupon: {
        discount_type: "percentage",
        discount_value: 5_000,
        minimum_spend_paise: 0,
        max_discount_paise: 300,
        is_active: true,
        starts_at: null,
        ends_at: null,
      },
    });
    expect(quote).toEqual({
      subtotalPaise: 1_000,
      discountPaise: 300,
      taxPaise: 0,
      totalPaise: 700,
      advanceDuePaise: 700,
      balanceDuePaise: 0,
    });
  });

  it("rejects invalid amounts and out-of-range percentages", () => {
    expect(() => calculateQuote({
      servicePricePaise: -1, addonPricesPaise: [], taxRateBasisPoints: 0,
      advanceType: "fixed", advanceValue: 0,
    })).toThrow(/non-negative/);
    expect(() => calculateQuote({
      servicePricePaise: 1, addonPricesPaise: [], taxRateBasisPoints: 0,
      advanceType: "percentage", advanceValue: 10_001,
    })).toThrow(/100%/);
    expect(() => calculateQuote({
      servicePricePaise: 1, addonPricesPaise: [], taxRateBasisPoints: 10_001,
      advanceType: "fixed", advanceValue: 0,
    })).toThrow(/Tax rate/);
  });

  it("uses exact paise arithmetic when basis-point products exceed safe integer precision", () => {
    const amount = 8_000_000_000_001;
    const tax = Number((BigInt(amount) * 9_999n) / 10_000n);
    expect(calculateQuote({
      servicePricePaise: amount,
      addonPricesPaise: [],
      taxRateBasisPoints: 9_999,
      advanceType: "fixed",
      advanceValue: 0,
    }).taxPaise).toBe(tax);
  });

  it("treats the coupon end time as exclusive", () => {
    const now = new Date("2026-10-17T10:00:00.000Z");
    expect(calculateQuote({
      servicePricePaise: 1_000,
      addonPricesPaise: [],
      taxRateBasisPoints: 0,
      advanceType: "fixed",
      advanceValue: 0,
      now,
      coupon: {
        discount_type: "fixed",
        discount_value: 500,
        minimum_spend_paise: 0,
        max_discount_paise: null,
        is_active: true,
        starts_at: null,
        ends_at: now.toISOString(),
      },
    }).discountPaise).toBe(0);
  });
});

describe("booking state transitions", () => {
  it("only permits expected transitions", () => {
    expect(canTransitionBooking("pending_payment", "confirmed")).toBe(true);
    expect(canTransitionBooking("payment_failed", "confirmed")).toBe(true);
    expect(canTransitionBooking("confirmed", "completed")).toBe(true);
    expect(canTransitionBooking("cancelled", "confirmed")).toBe(false);
    expect(() => assertBookingTransition("cancelled", "confirmed")).toThrow(/cannot transition/);
  });
});

/**
 * Tax.gs
 * ----------------------------------------------------------------------
 * Custom spreadsheet functions for US federal and California state
 * income tax on personal (single filer / MFJ) income.
 *
 * Use these from cells, e.g.:
 *   =FedTax(B12, 2025)                  // single filer (default)
 *   =FedTax(B12, 2025, "mfj")           // married filing jointly
 *   =CATax(B12, 2025)                   // CA state single filer
 *   =CATax(B12, 2025, "mfj")
 *
 * Legacy aliases (kept for back-compat with existing formulas):
 *   =FED_TAX_2023(income)   =FED_TAX_2024(income)   =FED_TAX_2025(income)
 *   =STATE_TAX_2023(income) =STATE_TAX_2024(income) =STATE_TAX_2025(income)
 *
 * Income passed in is GROSS income for that filer. The function
 * subtracts the standard deduction for the year/status and applies
 * marginal brackets.
 *
 * No external network call — brackets are hardcoded from the IRS
 * Rev. Proc. and California FTB tables. Adding a new year is a single
 * constant change in the BRACKETS_* and STD_DEDUCTION_* objects.
 *
 * 2025 federal standard deduction reflects the One Big Beautiful Bill
 * Act of 2025 retroactive bump (single: $15,750, MFJ: $31,500,
 * HoH: $23,625) rather than the original IRS Rev. Proc. 2024-40 values.
 * ----------------------------------------------------------------------
 */

// =====================  Federal brackets  =====================
// Each bracket: [upperEdge, marginalRate]. Last upperEdge = Infinity.
// Source: IRS Rev. Proc. for that year. Single filer + MFJ shown.

var FED_BRACKETS = {
  2023: {
    single: [
      [11000,   0.10],
      [44725,   0.12],
      [95375,   0.22],
      [182100,  0.24],
      [231250,  0.32],
      [578125,  0.35],
      [Infinity, 0.37]
    ],
    mfj: [
      [22000,   0.10],
      [89450,   0.12],
      [190750,  0.22],
      [364200,  0.24],
      [462500,  0.32],
      [693750,  0.35],
      [Infinity, 0.37]
    ]
  },
  2024: {
    single: [
      [11600,   0.10],
      [47150,   0.12],
      [100525,  0.22],
      [191950,  0.24],
      [243725,  0.32],
      [609350,  0.35],
      [Infinity, 0.37]
    ],
    mfj: [
      [23200,   0.10],
      [94300,   0.12],
      [201050,  0.22],
      [383900,  0.24],
      [487450,  0.32],
      [731200,  0.35],
      [Infinity, 0.37]
    ]
  },
  2025: {
    single: [
      [11925,   0.10],
      [48475,   0.12],
      [103350,  0.22],
      [197300,  0.24],
      [250525,  0.32],
      [626350,  0.35],
      [Infinity, 0.37]
    ],
    mfj: [
      [23850,   0.10],
      [96950,   0.12],
      [206700,  0.22],
      [394600,  0.24],
      [501050,  0.32],
      [751600,  0.35],
      [Infinity, 0.37]
    ]
  }
};

var FED_STD_DEDUCTION = {
  2023: { single: 13850, mfj: 27700, hoh: 20800 },
  2024: { single: 14600, mfj: 29200, hoh: 21900 },
  // 2025: reflects One Big Beautiful Bill Act of 2025 retroactive bump.
  2025: { single: 15750, mfj: 31500, hoh: 23625 }
};


// =====================  California brackets  =====================
// California FTB single + MFJ. CA also has a 1% Mental Health Services
// surcharge on taxable income over $1,000,000 — applied on top of the
// bracket schedule below.

var CA_BRACKETS = {
  2023: {
    single: [
      [10412,   0.01],
      [24684,   0.02],
      [38959,   0.04],
      [54081,   0.06],
      [68350,   0.08],
      [349137,  0.093],
      [418961,  0.103],
      [698271,  0.113],
      [Infinity, 0.123]
    ],
    mfj: [
      [20824,   0.01],
      [49368,   0.02],
      [77918,   0.04],
      [108162,  0.06],
      [136700,  0.08],
      [698274,  0.093],
      [837922,  0.103],
      [1396542, 0.113],
      [Infinity, 0.123]
    ]
  },
  2024: {
    single: [
      [10756,   0.01],
      [25499,   0.02],
      [40245,   0.04],
      [55866,   0.06],
      [70606,   0.08],
      [360659,  0.093],
      [432787,  0.103],
      [721314,  0.113],
      [Infinity, 0.123]
    ],
    mfj: [
      [21512,   0.01],
      [50998,   0.02],
      [80490,   0.04],
      [111732,  0.06],
      [141212,  0.08],
      [721318,  0.093],
      [865574,  0.103],
      [1442628, 0.113],
      [Infinity, 0.123]
    ]
  },
  // CA 2025 brackets — placeholder using 2024 values pending FTB final
  // publication. Update when FTB releases the 2025 indexed tables.
  // Replace upperEdge values below with FTB 2025 numbers when published.
  2025: {
    single: [
      [10756,   0.01],
      [25499,   0.02],
      [40245,   0.04],
      [55866,   0.06],
      [70606,   0.08],
      [360659,  0.093],
      [432787,  0.103],
      [721314,  0.113],
      [Infinity, 0.123]
    ],
    mfj: [
      [21512,   0.01],
      [50998,   0.02],
      [80490,   0.04],
      [111732,  0.06],
      [141212,  0.08],
      [721318,  0.093],
      [865574,  0.103],
      [1442628, 0.113],
      [Infinity, 0.123]
    ]
  }
};

var CA_STD_DEDUCTION = {
  2023: { single: 5363, mfj: 10726 },
  2024: { single: 5540, mfj: 11080 },
  2025: { single: 5540, mfj: 11080 }  // Placeholder; update when FTB publishes 2025.
};

var CA_MENTAL_HEALTH_THRESHOLD = 1000000;
var CA_MENTAL_HEALTH_RATE = 0.01;


// =====================  Public functions  =====================

/**
 * Compute US federal income tax for a given gross income, year, and
 * filing status.
 *
 * @param {number} grossIncome   Total gross income for the year (USD).
 * @param {number} year          4-digit tax year (e.g. 2025).
 * @param {string=} filingStatus "single" (default), "mfj", or "hoh".
 * @return {number}              Federal tax owed (USD), rounded to cents.
 * @customfunction
 */
function FedTax(grossIncome, year, filingStatus) {
  return computeIncomeTax_(
    grossIncome, year, filingStatus,
    FED_BRACKETS, FED_STD_DEDUCTION, /*hasMentalHealth=*/false
  );
}

/**
 * Compute California state income tax for a given gross income, year,
 * and filing status. Includes the 1% Mental Health Services surcharge
 * on taxable income over $1,000,000.
 *
 * @param {number} grossIncome   Total gross income for the year (USD).
 * @param {number} year          4-digit tax year (e.g. 2025).
 * @param {string=} filingStatus "single" (default) or "mfj".
 * @return {number}              CA tax owed (USD), rounded to cents.
 * @customfunction
 */
function CATax(grossIncome, year, filingStatus) {
  return computeIncomeTax_(
    grossIncome, year, filingStatus,
    CA_BRACKETS, CA_STD_DEDUCTION, /*hasMentalHealth=*/true
  );
}


// =====================  Legacy aliases (back-compat)  =====================
// These keep existing formulas in the Tax sheet working unchanged.

function FED_TAX_2023(income) { return FedTax(income, 2023, 'single'); }
function FED_TAX_2024(income) { return FedTax(income, 2024, 'single'); }
function FED_TAX_2025(income) { return FedTax(income, 2025, 'single'); }

function STATE_TAX_2023(income) { return CATax(income, 2023, 'single'); }
function STATE_TAX_2024(income) { return CATax(income, 2024, 'single'); }
function STATE_TAX_2025(income) { return CATax(income, 2025, 'single'); }


// =====================  Helpers (internal)  =====================

/**
 * Common tax-computation core used by both FedTax and CATax.
 */
function computeIncomeTax_(grossIncome, year, filingStatus, bracketsByYear, sdByYear, hasMentalHealth) {
  if (grossIncome == null || grossIncome === '' || isNaN(Number(grossIncome))) return 0;
  grossIncome = Number(grossIncome);
  if (grossIncome <= 0) return 0;

  var yr = parseInt(year, 10);
  if (isNaN(yr)) throw new Error('Year is required (e.g. 2025).');
  var status = String(filingStatus || 'single').toLowerCase();
  if (status === 'married' || status === 'married filing jointly') status = 'mfj';
  if (status === 'married filing separately') status = 'mfs';
  if (status === 'head of household') status = 'hoh';

  var yearBrackets = bracketsByYear[yr];
  if (!yearBrackets) {
    throw new Error('No tax brackets configured for year ' + yr + '. Add them to Tax.gs.');
  }
  var brackets = yearBrackets[status];
  if (!brackets) {
    // Fall back: MFS uses single brackets at half-thresholds; HoH uses single brackets
    // unless explicitly configured. Single is the universal fallback.
    brackets = yearBrackets.single;
    if (!brackets) throw new Error('No single-filer brackets for year ' + yr);
  }

  var sdYear = sdByYear[yr] || {};
  var sd = sdYear[status];
  if (sd == null) sd = sdYear.single || 0;

  var taxable = Math.max(0, grossIncome - sd);
  var tax = applyMarginalBrackets_(taxable, brackets);

  if (hasMentalHealth && taxable > CA_MENTAL_HEALTH_THRESHOLD) {
    tax += (taxable - CA_MENTAL_HEALTH_THRESHOLD) * CA_MENTAL_HEALTH_RATE;
  }

  // Round to cents
  return Math.round(tax * 100) / 100;
}

/**
 * Apply a marginal bracket schedule to a taxable-income amount.
 * @param {number} taxable
 * @param {Array<Array<number>>} brackets  Array of [upperEdge, rate].
 * @return {number} tax
 */
function applyMarginalBrackets_(taxable, brackets) {
  var tax = 0;
  var lower = 0;
  for (var i = 0; i < brackets.length; i++) {
    var upper = brackets[i][0];
    var rate = brackets[i][1];
    if (taxable > upper) {
      tax += (upper - lower) * rate;
      lower = upper;
    } else {
      tax += (taxable - lower) * rate;
      return tax;
    }
  }
  return tax;
}

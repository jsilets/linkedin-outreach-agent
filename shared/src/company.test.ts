import { describe, it, expect } from 'vitest';
import { extractCompany } from './company.js';

describe('extractCompany', () => {
  it('pulls the company after an "at" marker', () => {
    expect(extractCompany('Associate Director, EVSE Operations at PowerFlex')).toBe('PowerFlex');
    expect(extractCompany('Field Service Technician at Shell Recharge Solutions')).toBe(
      'Shell Recharge Solutions',
    );
    expect(extractCompany('Manager - EV Charging Operations at Toronto Parking Authority')).toBe(
      'Toronto Parking Authority',
    );
  });

  it('pulls the company after an "@" marker', () => {
    expect(extractCompany('VP Operations | EV Charging | Operational Turnarounds @ VoltiE')).toBe(
      'VoltiE',
    );
    expect(extractCompany('Field Service Technician @ ChargePoint | Hardware Diagnostics')).toBe(
      'ChargePoint',
    );
  });

  it('takes the LAST marker (the employer), not an earlier mention', () => {
    expect(extractCompany('Founder of Champion Wipes | EV Charging Ops @ Jule')).toBe('Jule');
  });

  it('stops at segment delimiters and sentence ends', () => {
    expect(extractCompany('EV Network Operations at Tesla. Dad to 3 wonderful kids.')).toBe('Tesla');
    expect(extractCompany('Head of Operations at Applegreen Electric US | EV Charging')).toBe(
      'Applegreen Electric US',
    );
    expect(extractCompany('Head of Network Operations at EVCS, I lead reliability')).toBe('EVCS');
  });

  it('accepts camelCase brand names', () => {
    expect(extractCompany('Chief Operating Officer (COO) at eVerged | Infrastructure')).toBe(
      'eVerged',
    );
    expect(extractCompany('Chief Operating Officer @ aetherEV ex. Tesla Regional Manager')).toBe(
      'aetherEV',
    );
  });

  it('treats a standalone "I" as a separator', () => {
    expect(extractCompany('Energy, Charging, EVs at Rivian I PG&E, Opower, ICF alum')).toBe(
      'Rivian',
    );
  });

  it('returns undefined when no company is clearly marked', () => {
    expect(extractCompany('EV Charging Service Operations & Technical Support Manager')).toBeUndefined();
    expect(extractCompany('Manager, O&M – EV Charging | Fleet Reliability | KPI Delivery')).toBeUndefined();
    expect(extractCompany('Field Service Technician')).toBeUndefined();
    expect(extractCompany(null)).toBeUndefined();
    expect(extractCompany('')).toBeUndefined();
    expect(extractCompany(undefined)).toBeUndefined();
  });

  it('does not extract a lowercase filler word after "at"', () => {
    expect(extractCompany('working at scale to improve reliability')).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { extractCompany } from './company.js';

describe('extractCompany', () => {
  it('pulls the company after an "at" marker', () => {
    expect(extractCompany('Associate Director, Field Operations at Meridian')).toBe('Meridian');
    expect(extractCompany('Field Service Technician at Acme Field Solutions')).toBe(
      'Acme Field Solutions',
    );
    expect(extractCompany('Manager - Field Operations at Metro Transit Authority')).toBe(
      'Metro Transit Authority',
    );
  });

  it('pulls the company after an "@" marker', () => {
    expect(extractCompany('VP Operations | Field Service | Operational Turnarounds @ Northwind')).toBe(
      'Northwind',
    );
    expect(extractCompany('Field Service Technician @ Globex | Hardware Diagnostics')).toBe(
      'Globex',
    );
  });

  it('takes the LAST marker (the employer), not an earlier mention', () => {
    expect(extractCompany('Founder of Champion Wipes | Field Ops @ Initech')).toBe('Initech');
  });

  it('stops at segment delimiters and sentence ends', () => {
    expect(extractCompany('Network Operations at Contoso. Dad to 3 wonderful kids.')).toBe('Contoso');
    expect(extractCompany('Head of Operations at Evergreen Retail US | Field Service')).toBe(
      'Evergreen Retail US',
    );
    expect(extractCompany('Head of Network Operations at NORTHCO, I lead reliability')).toBe('NORTHCO');
  });

  it('accepts camelCase brand names', () => {
    expect(extractCompany('Chief Operating Officer (COO) at eMeridian | Infrastructure')).toBe(
      'eMeridian',
    );
    expect(extractCompany('Chief Operating Officer @ aetherLabs ex. Contoso Regional Manager')).toBe(
      'aetherLabs',
    );
  });

  it('treats a standalone "I" as a separator', () => {
    expect(extractCompany('Operations, Field, Logistics at Corvus I Contoso, Umbrella, ACME alum')).toBe(
      'Corvus',
    );
  });

  it('returns undefined when no company is clearly marked', () => {
    expect(extractCompany('Field Service Operations & Technical Support Manager')).toBeUndefined();
    expect(extractCompany('Manager, O&M – Field Service | Fleet Reliability | KPI Delivery')).toBeUndefined();
    expect(extractCompany('Field Service Technician')).toBeUndefined();
    expect(extractCompany(null)).toBeUndefined();
    expect(extractCompany('')).toBeUndefined();
    expect(extractCompany(undefined)).toBeUndefined();
  });

  it('does not extract a lowercase filler word after "at"', () => {
    expect(extractCompany('working at scale to improve reliability')).toBeUndefined();
  });
});

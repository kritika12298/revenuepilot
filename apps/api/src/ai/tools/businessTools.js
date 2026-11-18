import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { describeServicePrice } from '../../lib/money.js';
import { defineTool } from './define.js';

export const getBusinessPricing = defineTool({
  name: 'get_business_pricing',
  description:
    "Fetch the business profile (name, hours, tone) and its active services with published prices. This is the " +
    'only source of truth for services and prices: never mention a price or service that is not listed here.',
  access: 'read',
  scope: 'business',
  input: z.strictObject({}),
  async handler(_input, runCtx) {
    const business = await prisma.business.findUnique({
      where: { id: runCtx.businessId },
      include: { services: { where: { active: true }, orderBy: { name: 'asc' } } },
    });
    return {
      business: {
        name: business.name,
        timezone: business.timezone,
        working_hours: business.workingHours,
        tone: business.commsPrefs?.tone ?? 'friendly',
        signature: business.commsPrefs?.signature ?? business.name,
      },
      services: business.services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price_type: s.priceType,
        price: describeServicePrice(s),
        duration_minutes: s.durationMinutes,
      })),
      rules: [
        'Quote only the prices above, exactly as written.',
        'QUOTE_ONLY services have no published price: say the owner will prepare a quote.',
        'Discounts, custom prices, quotes and bookings need the owner: use notify_business_owner.',
        'Do not promise specific dates or times; availability is not known to you.',
      ],
    };
  },
});

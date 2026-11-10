import type {
  AdapterContext,
  ContactCandidate,
  DataSource,
} from '../types';
import type { ContactDiscoveryInput } from './contact-discovery.adapter';
import { hashInt } from '../dedupe.util';

const FIRST_NAMES = ['Sarah', 'James', 'Emily', 'Michael', 'Laura', 'David', 'Jessica', 'Robert'];
const LAST_NAMES = ['Miller', 'Thompson', 'Carter', 'Brooks', 'Hayes', 'Sullivan', 'Reed', 'Foster'];
const ROLE_TITLES = [
  'Purchasing Manager',
  'Procurement Manager',
  'Sourcing Manager',
  'Import Manager',
  'CEO',
  'Founder',
];

/** Mock 实现（无 Apollo Key 降级）：确定性生成 1-3 名采购联系人，恒标注 source:'demo' */
export class MockContactDiscoveryAdapter {
  readonly name = 'ContactDiscoveryAdapter' as const;

  async discover(input: ContactDiscoveryInput, _ctx: AdapterContext): Promise<ContactCandidate[]> {
    const domain =
      input.company.website?.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] ??
      `${input.company.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`;

    const count = 1 + hashInt(`${input.company.name}:count`, 3);
    const candidates: ContactCandidate[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < count; i++) {
      const seed = `${input.company.name}:c${i}`;
      const first = FIRST_NAMES[hashInt(`${seed}:f`, FIRST_NAMES.length)];
      const last = LAST_NAMES[hashInt(`${seed}:l`, LAST_NAMES.length)];
      const title = ROLE_TITLES[hashInt(`${seed}:t`, ROLE_TITLES.length)];
      const email = `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
      if (seen.has(email)) continue;
      seen.add(email);

      const verifyRoll = hashInt(`${seed}:v`, 10);
      candidates.push({
        name: `${first} ${last}`,
        title,
        email,
        linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-demo`,
        country: input.company.country,
        // 部分标注 unverified/unknown，演示邮箱验证状态展示（契约小写）
        emailVerified:
          verifyRoll >= 7 ? 'verified' : verifyRoll >= 4 ? 'unverified' : 'unknown',
        source: 'demo' as DataSource,
      });
    }
    return candidates;
  }
}

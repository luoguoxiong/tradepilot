/**
 * TradePilot 种子数据 + 唯一约束验证脚本
 * 用法：npm run seed（在 server/ 下）
 *
 * 验收门（phases.md 阶段 3）：
 * 1. 插入演示数据：用户 / 产品（碳纤维鞋垫）/ 企业（DEMO 标注）/ 联系人 / 海关记录
 * 2. 验证唯一约束：重复插入应报唯一冲突（P2002），脚本捕获并判定通过
 */
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_USER = {
  email: 'demo@tradepilot.dev',
  name: 'Demo User',
  password: 'demo123456',
};

async function main() {
  console.log('>>> 1. 插入演示用户');
  const passwordHash = await bcrypt.hash(DEMO_USER.password, 10);
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER.email },
    update: {},
    create: { email: DEMO_USER.email, name: DEMO_USER.name, passwordHash },
  });
  console.log(`    用户: ${user.email}`);

  console.log('>>> 2. 插入演示产品（碳纤维鞋垫）');
  const product = await prisma.product.upsert({
    where: { id: 'seed-product-carbon-insole' },
    update: {},
    create: {
      id: 'seed-product-carbon-insole',
      userId: user.id,
      name: 'Carbon Fiber Insoles',
      description:
        'Carbon fiber arch-support insoles for sports and everyday footwear. Lightweight, durable, OEM/ODM available.',
      sellingPoints: ['100% carbon fiber plate', 'Ultralight 18g/pair', 'OEM/ODM with custom molding'],
      keywords: ['carbon fiber insoles', 'arch support insoles'],
      companyIntro:
        'We are a Chinese manufacturer specializing in carbon fiber footwear components, exporting to North America since 2015.',
    },
  });
  console.log(`    产品: ${product.name}`);

  console.log('>>> 3. 插入演示企业（source=DEMO 标注）');
  const companies = [
    {
      dedupeKey: 'summitsports.com',
      name: 'Summit Sports Gear LLC',
      website: 'https://www.summitsports.com',
      country: 'US',
      description: 'Distributor of premium sports accessories and footwear components. [DEMO data]',
      mainProducts: ['sports insoles', 'footwear accessories', 'running gear'],
      email: 'purchasing@summitsports.com',
      linkedinUrl: 'https://www.linkedin.com/company/summit-sports-gear',
      source: 'demo',
    },
    {
      dedupeKey: 'northline-imports.ca',
      name: 'Northline Imports Inc.',
      website: 'https://www.northline-imports.ca',
      country: 'CA',
      description: 'Importer of performance footwear components for Canadian retail chains. [DEMO data]',
      mainProducts: ['insoles', 'shoe inserts', 'orthotic components'],
      email: 'sourcing@northline-imports.ca',
      linkedinUrl: null,
      source: 'demo',
    },
  ];

  for (const c of companies) {
    const company = await prisma.company.upsert({
      where: { dedupeKey: c.dedupeKey },
      update: {},
      create: c,
    });
    console.log(`    企业: ${company.name} (${company.country}) [${company.source}]`);

    if (c.dedupeKey === 'summitsports.com') {
      await prisma.contact.upsert({
        where: { companyId_email: { companyId: company.id, email: 'sarah.miller@summitsports.com' } },
        update: {},
        create: {
          companyId: company.id,
          name: 'Sarah Miller',
          title: 'Purchasing Manager',
          email: 'sarah.miller@summitsports.com',
          linkedinUrl: 'https://www.linkedin.com/in/sarah-miller-summit',
          country: 'US',
          source: 'demo',
          emailVerified: 'VERIFIED',
        },
      });

      await prisma.customsRecord.createMany({
        data: [
          {
            companyId: company.id,
            companyName: company.name,
            importCountry: 'US',
            productDescription: 'Carbon fiber arch support insoles',
            hsCode: '6406.99',
            shipmentDate: new Date('2026-08-15'),
            quantity: '12,000 pairs',
            supplierCountry: 'CN',
            supplierName: '[DEMO supplier]',
            source: 'demo',
          },
          {
            companyId: company.id,
            companyName: company.name,
            importCountry: 'US',
            productDescription: 'Carbon fiber insole blanks',
            hsCode: '6406.99',
            shipmentDate: new Date('2026-02-20'),
            quantity: '9,500 pairs',
            supplierCountry: 'CN',
            supplierName: '[DEMO supplier]',
            source: 'demo',
          },
        ],
      });
      console.log(`    联系人 1 名 + 海关记录 2 条（均 DEMO 标注）`);
    }
  }

  console.log('>>> 4. 验证唯一约束：companies.dedupeKey 重复插入');
  try {
    await prisma.company.create({
      data: {
        dedupeKey: 'summitsports.com', // 已存在 → 应报唯一冲突
        name: 'Duplicate Test Co',
        country: 'US',
        source: 'demo',
      },
    });
    throw new Error('FAIL: 重复 dedupeKey 插入竟然成功，唯一约束未生效！');
  } catch (e) {
    assertUniqueViolation(e, 'companies.dedupeKey');
  }

  console.log('>>> 5. 验证唯一约束：contacts (companyId, email) 重复插入');
  const summit = await prisma.company.findUniqueOrThrow({ where: { dedupeKey: 'summitsports.com' } });
  try {
    await prisma.contact.create({
      data: {
        companyId: summit.id,
        name: 'Duplicate Contact',
        title: 'CEO',
        email: 'sarah.miller@summitsports.com', // 已存在 → 应报唯一冲突
        source: 'demo',
      },
    });
    throw new Error('FAIL: 重复 (companyId, email) 插入竟然成功，唯一约束未生效！');
  } catch (e) {
    assertUniqueViolation(e, 'contacts(companyId, email)');
  }

  console.log('\n=== 种子数据与约束验证全部通过 ===');
  console.log(`演示账号: ${DEMO_USER.email} / ${DEMO_USER.password}`);
}

function assertUniqueViolation(e: unknown, constraint: string) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    console.log(`    OK: ${constraint} 唯一冲突被正确拒绝 (P2002)`);
    return;
  }
  throw e;
}

main()
  .catch((e) => {
    console.error('SEED FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

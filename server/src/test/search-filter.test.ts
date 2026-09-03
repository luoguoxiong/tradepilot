import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocked, domainOf } from '../providers/search.js';

// 红线 R5：搜索结果过滤与去重规则
test('R5: 电商平台/目录站黑名单', () => {
  for (const url of [
    'https://www.amazon.com/insulated-bottle/dp/B01',
    'https://alibaba.com/product-detail/x',
    'https://www.aliexpress.com/item/x',
    'https://www.made-in-china.com/products/x',
    'https://www.facebook.com/pagename',
    'https://www.linkedin.com/company/x',
    'https://example.com/catalog.pdf',
  ]) {
    assert.ok(isBlocked(url), `${url} 应被过滤`);
  }
});

test('R5: 普通 B2B 官网不误杀', () => {
  for (const url of [
    'https://www.alpinedrinkware.de/products',
    'https://coolcups-us.com/about',
    'http://thermos-world.co.uk/',
  ]) {
    assert.ok(!isBlocked(url), `${url} 不应被过滤`);
  }
});

test('R5: 非法 URL / 非 http 协议拒绝', () => {
  assert.ok(isBlocked('javascript:alert(1)'));
  assert.ok(isBlocked('not-a-url'));
});

test('R5: domainOf 归一化 www', () => {
  assert.equal(domainOf('https://www.ExampleBottle.com/a?b=1'), 'examplebottle.com');
});

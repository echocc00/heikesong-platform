import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_DETAIL_FIELDS, CONFIDENCE_LABELS, MUTUALLY_EXCLUSIVE,
  assertKnownFields, assertMutuallyExclusive, assertConfidenceLabel,
} from '../src/domain/field-dictionary.js';

test('字段字典为每一种 flag kind 定义了字段', () => {
  for (const kind of ['self_vs_judge', 'burst_submit', 'identical_peer_pattern', 'low_variance', 'multi_account', 'tied_mutual_peer_rate', 'reverse_audit']) {
    assert.ok(Array.isArray(FLAG_DETAIL_FIELDS[kind]), `缺 ${kind} 的字段定义`);
    assert.ok(FLAG_DETAIL_FIELDS[kind].length > 0, `${kind} 的字段不能为空`);
  }
});

test('未知字段名被拒绝（R-AUD-06：并行前先定字段字典）', () => {
  const errors = assertKnownFields('low_variance', { judgeId: 'j1', stdev: 1, 随便写的字段: 3 });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('随便写的字段'));
  assert.deepEqual(assertKnownFields('low_variance', { judgeId: 'j1', stdev: 1 }), []);
});

test('字典里没有定义的 flag kind 被拒绝（没定义就没闸 = 等于没闸）', () => {
  const errors = assertKnownFields('字典里没有的 kind', { judgeId: 'j1' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('未知的 flag kind'));
});

test('互斥字段名同时出现被拒绝（借鉴维度 vs 同样点/差异点）', () => {
  const errors = assertMutuallyExclusive({ 借鉴维度: 'A', 同样点: 'B' });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('互斥'));
  assert.deepEqual(assertMutuallyExclusive({ 借鉴维度: 'A' }), []);
});

test('置信度只有一套标签', () => {
  assert.deepEqual(CONFIDENCE_LABELS, ['high', 'medium', 'low']);
  assert.equal(assertConfidenceLabel('high'), true);
  assert.equal(assertConfidenceLabel('probably-high'), false);
});

test('互斥组定义不为空', () => {
  assert.ok(MUTUALLY_EXCLUSIVE.length >= 1);
  assert.ok(MUTUALLY_EXCLUSIVE[0].fields.includes('借鉴维度'));
});

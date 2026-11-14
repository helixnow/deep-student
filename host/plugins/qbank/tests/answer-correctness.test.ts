import { describe, expect, it } from 'vitest';
import { checkAnswerCorrectness as check, extractChoiceKeys } from '../src/answer-correctness.ts';
import { valueFromStr } from '../src/raw-json-number.ts';

describe('question_bank_service.rs answer correctness', () => {
  it('test_single_choice_basic_and_case_insensitive', () => {
    expect(check('A', 'A', 'single_choice')).toEqual([true, false]);
    expect(check('a', 'A.', 'single_choice')).toEqual([true, false]);
    expect(check('B', 'A', 'single_choice')).toEqual([false, false]);
  });
  it('test_single_choice_answer_with_option_text', () => {
    expect(check('A', 'A. 三角形内角和为180°', 'single_choice')).toEqual([true, false]);
    expect(check('B', 'A. 三角形内角和为180°', 'single_choice')).toEqual([false, false]);
    expect(check('A', '正确答案：A', 'single_choice')).toEqual([true, false]);
  });
  it('test_multiple_choice_order_and_missing', () => {
    expect(check('BA', 'AB', 'multiple_choice')).toEqual([true, false]);
    expect(check('A,B', 'B、A', 'multiple_choice')).toEqual([true, false]);
    expect(check('A', 'AB', 'multiple_choice')).toEqual([false, false]);
    expect(check('ABC', 'AB', 'multiple_choice')).toEqual([false, false]);
  });
  it('test_multiple_choice_answer_with_option_text', () => {
    expect(check('AC', 'A. 苹果 C. 橙子', 'multiple_choice')).toEqual([true, false]);
    expect(check('A', 'A. 苹果 C. 橙子', 'multiple_choice')).toEqual([false, false]);
  });
  it('test_fill_blank_always_ai_graded', () => {
    expect(check(' Newton ', 'newton', 'fill_blank')).toEqual([false, true]);
    expect(check('能量 守恒', '能量守恒', 'fill_blank')).toEqual([false, true]);
    expect(check('动量守恒', '能量守恒', 'fill_blank')).toEqual([false, true]);
    expect(check('2', null, 'fill_blank')).toEqual([false, true]);
  });
  it('test_subjective_needs_manual_grading', () => {
    expect(check('我的论述……', '参考答案', 'short_answer')).toEqual([false, true]);
    expect(check('证明过程', '参考证明', 'proof')).toEqual([false, true]);
  });
  it('test_missing_answer_needs_manual_grading', () => {
    expect(check('A', null, 'single_choice')).toEqual([false, true]);
    expect(check('A', '  ', 'single_choice')).toEqual([false, true]);
  });
  it('test_extract_choice_keys_conservative', () => {
    const keys = (text: string) => extractChoiceKeys(text);
    expect(keys('A')).toEqual(['A']);
    expect(keys('abd')).toEqual(['A', 'B', 'D']);
    expect(keys('A、C')).toEqual(['A', 'C']);
    expect(keys('A. 内容 C. 内容')).toEqual(['A', 'C']);
    expect(keys('（B）')).toEqual(['B']);
    expect(keys('选A。')).toEqual(['A']);
    expect(keys('答案是第一个')).toBeNull();
    expect(keys('')).toBeNull();
    expect(keys('the answer')).toBeNull();
    expect(keys('Ａ')).toEqual(['A']);
    expect(keys('（Ｂ）')).toEqual(['B']);
  });
  it('test_fullwidth_normalization_in_judging', () => {
    expect(check('Ａ', 'A', 'single_choice')).toEqual([true, false]);
    expect(check('ＢＡ', 'AB', 'multiple_choice')).toEqual([true, false]);
    expect(check('１２３', '123', 'fill_blank')).toEqual([false, true]);
    expect(check('ｎｅｗｔｏｎ', 'Newton', 'fill_blank')).toEqual([false, true]);
    expect(check('能量\u3000守恒', '能量守恒', 'fill_blank')).toEqual([false, true]);
    expect(check('Ｂ', 'A', 'single_choice')).toEqual([false, false]);
  });
  it('test_true_false_lenient_parsing', () => {
    expect(check('true', 'true', 'true_false')).toEqual([true, false]);
    expect(check('对', 'true', 'true_false')).toEqual([true, false]);
    expect(check('√', 'true', 'true_false')).toEqual([true, false]);
    expect(check('错误', 'false', 'true_false')).toEqual([true, false]);
    expect(check('×', 'true', 'true_false')).toEqual([false, false]);
    expect(check('也许吧', 'true', 'true_false')).toEqual([false, false]);
    expect(check('true', '视情况而定', 'true_false')).toEqual([false, true]);
    expect(check('true', null, 'true_false')).toEqual([false, true]);
  });
  it('test_numeric_tolerance_and_lenient_input', () => {
    const sd = (t: number, mode: string) => ({ answer_value: 3.14, tolerance: t, unit: 'm', tolerance_mode: mode });
    expect(check('3.15', null, 'numeric', sd(0.01, 'absolute'))).toEqual([true, false]);
    expect(check('3.16', null, 'numeric', sd(0.01, 'absolute'))).toEqual([false, false]);
    expect(check('3.17', null, 'numeric', sd(0.01, 'relative'))).toEqual([true, false]);
    expect(check('3.14 m', null, 'numeric', sd(0, 'absolute'))).toEqual([true, false]);
    expect(check('３.１４', null, 'numeric', sd(0, 'absolute'))).toEqual([true, false]);
    expect(check('1,234.5', null, 'numeric', { answer_value: 1234.5, tolerance: 0 })).toEqual([true, false]);
    expect(check('1/2', null, 'numeric', { answer_value: 0.5, tolerance: 0 })).toEqual([true, false]);
    expect(check('3.14', '3.14', 'numeric')).toEqual([true, false]);
    expect(check('3.14', '约等于圆周率', 'numeric')).toEqual([false, true]);
    expect(check('abc', '3.14', 'numeric')).toEqual([false, false]);
  });
  it('test_ordering_strict_order', () => {
    const sd = { items: [{ key: 'A', content: '一' }, { key: 'B', content: '二' }, { key: 'C', content: '三' }], correct_order: ['B', 'A', 'C'] };
    expect(check('["B","A","C"]', null, 'ordering', sd)).toEqual([true, false]);
    expect(check('["A","B","C"]', null, 'ordering', sd)).toEqual([false, false]);
    expect(check('["B","A"]', null, 'ordering', sd)).toEqual([false, false]);
    expect(check('b、a、c', null, 'ordering', sd)).toEqual([true, false]);
    expect(check('["B","A"]', null, 'ordering')).toEqual([false, true]);
  });
  it('test_matching_pair_set_equality', () => {
    const sd = {
      left: [{ key: 'L1', content: '水' }, { key: 'L2', content: '火' }],
      right: [{ key: 'R1', content: 'H2O' }, { key: 'R2', content: 'Fire' }],
      pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }],
    };
    expect(check('{"pairs":[{"left":"L2","right":"R2"},{"left":"L1","right":"R1"}]}', null, 'matching', sd)).toEqual([true, false]);
    expect(check('{"pairs":[{"left":"L1","right":"R2"},{"left":"L2","right":"R1"}]}', null, 'matching', sd)).toEqual([false, false]);
    expect(check('{"pairs":[{"left":"L1","right":"R1"}]}', null, 'matching', sd)).toEqual([false, false]);
    expect(check('{"pairs":[{"left":"L1","right":"R1"},{"left":"L1","right":"R1"}]}', null, 'matching', sd)).toEqual([false, false]);
    expect(check('随便写的', null, 'matching', sd)).toEqual([false, false]);
    expect(check('{"pairs":[]}', null, 'matching')).toEqual([false, true]);
  });
  // question_bank_service.rs:1366-1379：answer_value/tolerance 取 `Value::as_f64`（arbitrary_precision 下按原文解析，
  // 非有限为 None），Rust 写出的 2.50 / 1e-2 / 大整数 / 1e400 与普通数字同样参与判分。
  it('numeric_structured_data_reads_rust_written_numbers_with_as_f64', () => {
    const sd = (text: string) => valueFromStr(text);
    expect(check('2.5', null, 'numeric', sd('{"answer_value":2.50,"tolerance":1e-2}'))).toEqual([true, false]);
    expect(check('2.509', '9', 'numeric', sd('{"answer_value":2.50,"tolerance":1e-2}'))).toEqual([true, false]);
    expect(check('2.52', null, 'numeric', sd('{"answer_value":2.50,"tolerance":1e-2}'))).toEqual([false, false]);
    expect(check('12345678901234567890', null, 'numeric', sd('{"answer_value":12345678901234567890}')))
      .toEqual([true, false]);
    expect(check('3.2', null, 'numeric', sd('{"answer_value":3.14,"tolerance":1e400}'))).toEqual([false, false]);
    expect(check('3.14', null, 'numeric', sd('{"answer_value":1e400}'))).toEqual([false, true]);
  });
  it('test_fill_blank_structured_multi_blank_always_ai_graded', () => {
    const sd = { blanks: [{ answers: ['牛顿', 'Newton'], case_sensitive: false, trim: true }, { answers: ['1687'] }] };
    expect(check('["newton","1687"]', null, 'fill_blank', sd)).toEqual([false, true]);
    expect(check('["牛顿","1688"]', null, 'fill_blank', sd)).toEqual([false, true]);
    expect(check('["牛顿"]', null, 'fill_blank', sd)).toEqual([false, true]);
    expect(check('pH', null, 'fill_blank', { blanks: [{ answers: ['pH'], case_sensitive: true, trim: true }] })).toEqual([false, true]);
    expect(check('能量守恒', null, 'fill_blank', { blanks: [{ answers: ['能量守恒'] }] })).toEqual([false, true]);
  });
});

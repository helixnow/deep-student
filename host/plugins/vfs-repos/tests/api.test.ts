import { expectTypeOf, it } from 'vitest';
import type { Question, QuestionImage, QuestionType, VfsReposService } from '../api.ts';

it('publishes the question wire types and connection-bound repository contract', () => {
  expectTypeOf<Question['question_type']>().toEqualTypeOf<QuestionType>();
  expectTypeOf<Question['card_id']>().toEqualTypeOf<string | null>();
  expectTypeOf<QuestionImage['role']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<VfsReposService['pathCache']['getPath']>().toBeFunction();
});

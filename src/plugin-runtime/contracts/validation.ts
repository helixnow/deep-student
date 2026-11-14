import { Validator } from '@cfworker/json-schema';
import schema from '../../../contracts/translation/v1.json' with { type: 'json' };
import { PluginError, type MethodContract } from '../host.js';

function validate(definition: string, nullable = false): (value: unknown) => void {
  const validator = new Validator({
    definitions: schema.definitions,
    ...(nullable ? { anyOf: [{ $ref: `#/definitions/${definition}` }, { type: 'null' }] }
      : { $ref: `#/definitions/${definition}` }),
  });
  return (value) => {
    const result = validator.validate(value);
    if (!result.valid) throw new PluginError('contract_violation', `${definition}: ${JSON.stringify(result.errors)}`);
  };
}

export const translationContract: MethodContract = {
  input: validate('TranslationRequest'),
  output: validate('TranslationResponse', true),
  event: validate('TranslationEvent'),
};
export const validateSegmentRequest = validate('SegmentRequest');
export const validateStreamStatus = validate('StreamStatus');
export const validateStreamFailure = validate('StreamFailure');

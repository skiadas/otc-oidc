import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'oidc-provider';
import { classifyInteractionError } from '../src/routes/interaction.js';

describe('classifyInteractionError', () => {
  it('maps a missing interaction session to an expired-request page', () => {
    const page = classifyInteractionError(
      new errors.SessionNotFound('interaction session id cookie not found'),
    );
    assert.equal(page.status, 400);
    assert.equal(page.title, 'Expired request');
  });

  it('maps an expired interaction to an expired-request page', () => {
    const page = classifyInteractionError(
      new errors.SessionNotFound('authorization request has expired'),
    );
    assert.equal(page.status, 400);
  });

  it('maps an unrelated oidc-provider error to a generic server error', () => {
    const page = classifyInteractionError(new errors.InvalidGrant('grant request is invalid'));
    assert.equal(page.status, 500);
    assert.equal(page.title, 'Something went wrong');
  });

  it('maps an unknown Error to a generic server error', () => {
    assert.equal(classifyInteractionError(new Error('boom')).status, 500);
  });

  it('maps a non-Error value to a generic server error', () => {
    assert.equal(classifyInteractionError('boom').status, 500);
  });
});

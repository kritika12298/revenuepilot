import { ValidationError } from '../lib/errors.js';

function formatIssues(issues, location) {
  return issues.map((i) => ({
    location,
    path: i.path.join('.'),
    message: i.message,
  }));
}

/**
 * Validates request parts against Zod schemas. Parsed (coerced, defaulted)
 * values are stored on `req.valid` because Express 5 makes `req.query`
 * read-only.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const problems = [];
    for (const location of ['params', 'query', 'body']) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (result.success) valid[location] = result.data;
      else problems.push(...formatIssues(result.error.issues, location));
    }
    if (problems.length) return next(new ValidationError(problems));
    req.valid = valid;
    return next();
  };
}

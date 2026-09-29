export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMPTY_GROUP'
  | 'ALL_CENSORED'
  | 'ZERO_VARIANCE'
  | 'GROUP_MISSING'
  | 'TAU_TOO_LARGE'
  | 'MEDIAN_NOT_REACHED'
  | 'UNIT_MISMATCH'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorStatus = (code: ErrorCode): number => {
  switch (code) {
    case 'VALIDATION':
    case 'EMPTY_GROUP':
    case 'ALL_CENSORED':
    case 'ZERO_VARIANCE':
    case 'GROUP_MISSING':
    case 'TAU_TOO_LARGE':
    case 'MEDIAN_NOT_REACHED':
    case 'UNIT_MISMATCH':
      return 422;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    default:
      return 500;
  }
};

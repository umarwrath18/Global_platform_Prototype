import { MerchantApiError, MerchantApiErrorCode } from '../merchants/merchant-models';

/** An error reply from the simulated merchant backend (status code and API error body). */
export class ApiError {
  constructor(
    readonly status: number,
    readonly body: MerchantApiError,
  ) {}
}

export const fail = (status: number, code: MerchantApiErrorCode, extra: Omit<MerchantApiError, 'code'> = {}): never => {
  throw new ApiError(status, { code, ...extra });
};

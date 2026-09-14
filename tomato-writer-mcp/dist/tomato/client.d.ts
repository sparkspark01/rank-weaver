/**
 * 番茄作家后台 HTTP 客户端。
 *
 * 鉴权 = Cookie + X-Secsdk-Csrf-Token（会话级固定）。实测读/写接口均不需要
 * 风控签名 a_bogus/msToken（那是前端风控 SDK 在网络层注入的，服务端对带
 * cookie + csrf 的作家接口不强制校验）。所有接口返回 {code, message, data}，
 * code===0 为成功。
 */
export interface TomatoAuth {
    cookie: string;
    csrfToken: string;
}
export type Params = Record<string, string | number | boolean>;
export declare class TomatoApiError extends Error {
    readonly path: string;
    readonly code: number;
    constructor(path: string, code: number, message: string);
}
export declare class TomatoClient {
    private readonly auth;
    constructor(auth: TomatoAuth);
    private headers;
    /** GET，参数走 query string。 */
    get(path: string, params?: Params): Promise<any>;
    /** POST，参数走 application/x-www-form-urlencoded。 */
    post(path: string, params?: Params): Promise<any>;
    private parse;
}

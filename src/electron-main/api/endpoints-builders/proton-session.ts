import {concatMap, first} from "rxjs/operators";
import {from, lastValueFrom, race, throwError, timer} from "rxjs";
import {pick} from "remeda";

import {Context} from "src/electron-main/model";
import {IpcMainApiEndpoints} from "src/shared/api/main-process";
import {PLATFORM} from "src/electron-main/constants";
import {filterProtonSessionTokenCookies} from "src/electron-main/util";
import {resolveInitializedAccountSession} from "src/electron-main/session";

// TODO enable minimal logging
// const logger = curryFunctionMembers(electronLog, __filename);

function pickTokenCookiePropsToApply(
    cookie: DeepReadonly<Electron.Cookie>,
): Pick<typeof cookie, "httpOnly" | "name" | "path" | "secure" | "value"> {
    return pick(cookie, ["httpOnly", "name", "path", "secure", "value"]);
}

export async function buildEndpoints(
    ctx: Context,
): Promise<Pick<IpcMainApiEndpoints,
    | "resolveSavedProtonClientSession"
    | "saveProtonSession"
    | "resetSavedProtonSession"
    | "applySavedProtonBackendSession"
    | "saveSessionStoragePatch"
    | "resolvedSavedSessionStoragePatch"
    | "resetProtonBackendSession">> {
    const endpoints: Unpacked<ReturnType<typeof buildEndpoints>> = {
        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async resolveSavedProtonClientSession({login, apiEndpointOrigin}) {
            const savedSession = ctx.sessionStorage.getSession({login, apiEndpointOrigin});

            if (!savedSession) {
                return null;
            }

            const windowName = savedSession.window.name;

            if (!windowName) {
                return null;
            }

            return {
                sessionStorage: savedSession.sessionStorage,
                windowName,
            };
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async saveProtonSession({login, apiEndpointOrigin, clientSession}) {
            const session = resolveInitializedAccountSession({login});
            const data = {
                login,
                apiEndpointOrigin,
                session: {
                    cookies: await session.cookies.get({}),
                    sessionStorage: clientSession.sessionStorage,
                    window: {
                        name: clientSession.windowName,
                    },
                },
            } as const;

            const {accessTokens, refreshTokens} = filterProtonSessionTokenCookies(data.session.cookies);

            if (accessTokens.length > 1 || refreshTokens.length > 1) {
                throw new Error([
                    `The app refuses to save more than one "proton-session" cookies records set `,
                    `(access tokens count: ${accessTokens.length}, refresh tokens count: ${refreshTokens.length}).`,
                ].join(""));
            }

            await ctx.sessionStorage.saveSession(data);
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async resetSavedProtonSession({login, apiEndpointOrigin}) {
            await ctx.sessionStorage.clearSession({login, apiEndpointOrigin});
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async applySavedProtonBackendSession({login, apiEndpointOrigin}) {
            const savedSession = ctx.sessionStorage.getSession({login, apiEndpointOrigin});

            // resetting the session before applying cookies from storage
            await endpoints.resetProtonBackendSession({login});

            if (!savedSession) {
                return false;
            }

            const tokenCookie = filterProtonSessionTokenCookies(savedSession.cookies);
            const accessTokenCookie = [...tokenCookie.accessTokens].pop();
            const refreshTokenCookie = [...tokenCookie.refreshTokens].pop();

            if (!accessTokenCookie || !refreshTokenCookie) {
                return false;
            }

            const session = resolveInitializedAccountSession({login});
            const sameSiteNoneCookieAttribute: Readonly<NoExtraProps<Pick<import("electron").CookiesSetDetails, "sameSite" | "secure">>> = {
                sameSite: "no_restriction",
                secure: true, // "samesite=none" attribute requires "secure" attribute
            };
            await Promise.all([
                session.cookies.set({
                    ...pickTokenCookiePropsToApply(accessTokenCookie),
                    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                    url: `${apiEndpointOrigin}${accessTokenCookie.path}`,
                    ...sameSiteNoneCookieAttribute,
                }),
                session.cookies.set({
                    ...pickTokenCookiePropsToApply(refreshTokenCookie),
                    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                    url: `${apiEndpointOrigin}${refreshTokenCookie.path}`,
                    ...sameSiteNoneCookieAttribute,
                }),
            ]);

            return true;
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async saveSessionStoragePatch({login, apiEndpointOrigin, sessionStorageItem: {__cookieStore__}}) {
            await ctx.sessionStorage.saveSessionStoragePatch({login, apiEndpointOrigin, __cookieStore__});
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async resolvedSavedSessionStoragePatch(arg) {
            return ctx.sessionStorage.getSessionStoragePatch(arg);
        },

        // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
        async resetProtonBackendSession({login}) {
            const session = resolveInitializedAccountSession({login});
            const config = await lastValueFrom(ctx.config$.pipe(first()));
            const {timeouts: {clearSessionStorageData: timeoutMs}} = config;

            // delete session._documentCookieJar_;

            await lastValueFrom(
                race(
                    from(
                        // TODO e2e / playwright: "session.clearStorageData()" hangs when executed e2e test flow on "win32" system
                        BUILD_ENVIRONMENT === "e2e" && PLATFORM === "win32"
                            ? Promise.resolve()
                            : session.clearStorageData()
                    ),
                    timer(timeoutMs).pipe(
                        concatMap(() => throwError(new Error(`Session clearing failed in ${timeoutMs}ms`))),
                    ),
                ),
            );
        },
    };

    return endpoints;
}

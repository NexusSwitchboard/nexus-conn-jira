import { Request, Response, Application, NextFunction } from 'express';
import {logger} from "./auth";
import _ from "lodash";

export default (app: Application, verifiedParameters: Record<string, any>) => {

    function getHostScriptUrl() {
        return 'https://connect-cdn.atl-paas.net/all.js';
    }

    function hostResourceUrl(baseUrl: string, ext: string) {
        let resource = 'all.' + ext;
        if (app.get('env') === 'development') {
            resource = 'all-debug.' + ext;
        }

        return baseUrl + '/atlassian-connect/' + resource;
    }

    function extractHost(uri: string) {
        const pathIndex = uri.indexOf('/');
        if (pathIndex > -1) {
            return uri.substring(0, pathIndex);
        }
        return uri;
    }

    // populate 'res.locals' which can be used in templates for variable substitution
    // If authenticated, the JWT data is authoritative, otherwise we use the URL params

    return (req: Request, res: Response, next: NextFunction) => {

        function getParam(key: string) {
            const value = req.query[key];
            if (value === undefined) {
                return (req.body || {})[key];
            }

            return value;
        }

        function getBaseUrlFromQueryParameters() {
            const hostUrl = getParam('xdm_e');
            return hostUrl ? hostUrl + (getParam('cp') || '') : '';
        }

        const params: Record<string, any> = {
            title: "Nexus Addon",// TODO: Need to fill this in
            addonKey: "", // TODO: Need to fill this in
            license: getParam('lic'),
            localBaseUrl: "", // TODO: Need to fill this in
            clientKey: '', // only available for authenticated requests
            token: '', // only available for authenticated requests
        };

        // Populate whatever data we have come through
        const timezone = getParam('tz');
        const locale = getParam('loc');
        const userId = getParam('user_id');
        // User Account ID not provided as part of context params

        if(timezone || locale || userId) {
            logger('Please note that timezone, locale, userId and userKey context parameters are deprecated.');
            logger('See https://ecosystem.atlassian.net/browse/ACEJS-115');
        }

        // Deprecated, as per https://ecosystem.atlassian.net/browse/ACEJS-115
        if(timezone) {
            params.timezone = timezone;
        }
        if(locale) {
            params.locale = locale;
        }
        if(userId) {
            params.userId = userId;
        }

        params.hostBaseUrl = getBaseUrlFromQueryParameters();

        if (verifiedParameters) {
            // Likely due to a bug, we call it userId but its actually userKey.
            if(verifiedParameters.userKey) {
                params.userId = verifiedParameters.userKey;
            }
            params.userAccountId = verifiedParameters.userAccountId;
            params.clientKey = verifiedParameters.clientKey;
            params.hostBaseUrl = verifiedParameters.hostBaseUrl;
            params.token = verifiedParameters.token;

            if (verifiedParameters.context) {
                params.context = verifiedParameters.context;
            }
        }

        // derived parameters
        params.hostUrl = extractHost(params.hostBaseUrl);
        params.hostStylesheetUrl = hostResourceUrl(params.hostBaseUrl, "css");
        params.hostScriptUrl = getHostScriptUrl();

        res.locals = _.extend({}, res.locals || {}, params);

        next();
    };
};

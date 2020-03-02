// @ts-ignore
import express, { Application, Request, Response, NextFunction } from 'express';
import createJiraConnection, { JiraConnection } from '../src/index';
import { config } from 'dotenv';

config();

interface IContext {
    app: Application,
    conn: JiraConnection
}

const context: IContext = {
    app: undefined,
    conn: undefined
};

beforeAll(() => {
    context.app = express();
});

test('initialize the connection', () => {
    const subApp = express();
    context.app.use(subApp);
    context.conn = createJiraConnection({
        host: process.env.JIRA_HOST,
        username: process.env.JIRA_USERNAME,
        apiToken: process.env.JIRA_API_KEY,

        // This is required if using the add-on functionality in the connection.  This is used
        //  to serve up webhooks and the addon config file.s
        subApp,

        // the unique name for this jira addon
        addOnConfig: {
            key: 'nexus-addon'
        },

        // this has to be unique for this app.  For example, this will likely be something like
        //  https://<domain>/m/mymod.
        baseUrl: 'https://nexus.ngrok.io:3000/',

        // A dictionary of webhooks where the key is the list of possible events:
        //  https://developer.atlassian.com/cloud/jira/platform/modules/webhook/
        webhooks: [
            {
                definition: {
                    event: 'issue:created',
                    filter: 'project=AGTEST'
                },
                handler: (_req: Request, _res: Response, _next: NextFunction) => {
                    // tslint:disable-next-line:no-console
                    console.log('here');
                }
            }
        ]
    }) as JiraConnection;
});

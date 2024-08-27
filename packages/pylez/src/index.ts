/*
 * nodeMain.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Provides the main entrypoint to the server when running in Node.
 */

import { BackgroundAnalysisRunner } from 'pyright-internal/backgroundAnalysis';
import { ServiceProvider } from 'pyright-internal/common/serviceProvider';
import { run } from 'pyright-internal/nodeServer';
import { Pylez } from './pylez';

export function main() {
    run(
        (conn) => new Pylez(conn, /** maxWorkers */ 1),
        () => {
            const runner = new BackgroundAnalysisRunner(new ServiceProvider());
            runner.start();
        }
    );
}

main();

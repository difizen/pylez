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

export function main(maxWorkers: number) {
    run(
        (conn) => new Pylez(conn, maxWorkers),
        () => {
            const runner = new BackgroundAnalysisRunner(new ServiceProvider());
            runner.start();
        }
    );
}

import { main } from 'pylez/nodeMain';

Error.stackTraceLimit = 256;

// VS Code version of the server has one background thread.
main(/* maxWorkers */ 1);

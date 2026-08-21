import {
  TOOL_DEFINITION as AbapGitGetErrorLog_Tool,
  handleAbapGitGetErrorLog,
} from '../../../handlers/abapgit/readonly/handleAbapGitGetErrorLog';
import {
  TOOL_DEFINITION as AbapGitGetRepo_Tool,
  handleAbapGitGetRepo,
} from '../../../handlers/abapgit/readonly/handleAbapGitGetRepo';
import {
  TOOL_DEFINITION as AbapGitListRepos_Tool,
  handleAbapGitListRepos,
} from '../../../handlers/abapgit/readonly/handleAbapGitListRepos';
import {
  handleReadBehaviorDefinition,
  TOOL_DEFINITION as ReadBehaviorDefinition_Tool,
} from '../../../handlers/behavior_definition/readonly/handleReadBehaviorDefinition';
import {
  handleReadBehaviorImplementation,
  TOOL_DEFINITION as ReadBehaviorImplementation_Tool,
} from '../../../handlers/behavior_implementation/readonly/handleReadBehaviorImplementation';
import {
  handleReadClass,
  TOOL_DEFINITION as ReadClass_Tool,
} from '../../../handlers/class/readonly/handleReadClass';
import {
  TOOL_DEFINITION as GetObjectVersionDiff_Tool,
  handleGetObjectVersionDiff,
} from '../../../handlers/common/readonly/handleGetObjectVersionDiff';
import {
  TOOL_DEFINITION as GetObjectVersionSource_Tool,
  handleGetObjectVersionSource,
} from '../../../handlers/common/readonly/handleGetObjectVersionSource';
import {
  TOOL_DEFINITION as GetObjectVersions_Tool,
  handleGetObjectVersions,
} from '../../../handlers/common/readonly/handleGetObjectVersions';
import {
  handleReadDataElement,
  TOOL_DEFINITION as ReadDataElement_Tool,
} from '../../../handlers/data_element/readonly/handleReadDataElement';
import {
  handleReadDdl,
  TOOL_DEFINITION as ReadDdl_Tool,
} from '../../../handlers/ddl/readonly/handleReadDdl';
import {
  TOOL_DEFINITION as DebuggerGetStack_Tool,
  handleDebuggerGetStack,
} from '../../../handlers/debugger/readonly/handleDebuggerGetStack';
import {
  TOOL_DEFINITION as DebuggerGetVariable_Tool,
  handleDebuggerGetVariable,
} from '../../../handlers/debugger/readonly/handleDebuggerGetVariable';
import {
  TOOL_DEFINITION as DebuggerListBreakpoints_Tool,
  handleDebuggerListBreakpoints,
} from '../../../handlers/debugger/readonly/handleDebuggerListBreakpoints';
import {
  handleReadDomain,
  TOOL_DEFINITION as ReadDomain_Tool,
} from '../../../handlers/domain/readonly/handleReadDomain';
import {
  TOOL_DEFINITION as GetEnhancementImpl_Tool,
  handleGetEnhancementImpl,
} from '../../../handlers/enhancement/readonly/handleGetEnhancementImpl';
import {
  TOOL_DEFINITION as GetEnhancementSpot_Tool,
  handleGetEnhancementSpot,
} from '../../../handlers/enhancement/readonly/handleGetEnhancementSpot';
import {
  TOOL_DEFINITION as GetEnhancements_Tool,
  handleGetEnhancements,
} from '../../../handlers/enhancement/readonly/handleGetEnhancements';
import {
  handleReadFunctionGroup,
  TOOL_DEFINITION as ReadFunctionGroup_Tool,
} from '../../../handlers/function_group/readonly/handleReadFunctionGroup';
import {
  handleListFunctionGroupIncludes,
  TOOL_DEFINITION as ListFunctionGroupIncludes_Tool,
} from '../../../handlers/function_include/readonly/handleListFunctionGroupIncludes';
import {
  handleListFunctionModules,
  TOOL_DEFINITION as ListFunctionModules_Tool,
} from '../../../handlers/function_include/readonly/handleListFunctionModules';
import {
  handleReadFunctionInclude,
  TOOL_DEFINITION as ReadFunctionInclude_Tool,
} from '../../../handlers/function_include/readonly/handleReadFunctionInclude';
import {
  handleReadFunctionModule,
  TOOL_DEFINITION as ReadFunctionModule_Tool,
} from '../../../handlers/function_module/readonly/handleReadFunctionModule';
import {
  TOOL_DEFINITION as GetInclude_Tool,
  handleGetInclude,
} from '../../../handlers/include/readonly/handleGetInclude';
import {
  TOOL_DEFINITION as GetIncludesList_Tool,
  handleGetIncludesList,
} from '../../../handlers/include/readonly/handleGetIncludesList';
import {
  handleReadInterface,
  TOOL_DEFINITION as ReadInterface_Tool,
} from '../../../handlers/interface/readonly/handleReadInterface';
import {
  handleReadMessageClass,
  TOOL_DEFINITION as ReadMessageClass_Tool,
} from '../../../handlers/message_class/readonly/handleReadMessageClass';
import {
  handleReadMessageClassMessage,
  TOOL_DEFINITION as ReadMessageClassMessage_Tool,
} from '../../../handlers/message_class/readonly/handleReadMessageClassMessage';
import {
  handleReadMetadataExtension,
  TOOL_DEFINITION as ReadMetadataExtension_Tool,
} from '../../../handlers/metadata_extension/readonly/handleReadMetadataExtension';
import {
  TOOL_DEFINITION as CompareObjectAcrossSystems_Tool,
  handleCompareObjectAcrossSystems,
} from '../../../handlers/multisystem/readonly/handleCompareObjectAcrossSystems';
import {
  TOOL_DEFINITION as ComparePackageAcrossLandscape_Tool,
  handleComparePackageAcrossLandscape,
} from '../../../handlers/multisystem/readonly/handleComparePackageAcrossLandscape';
import {
  TOOL_DEFINITION as ComparePackageAcrossSystems_Tool,
  handleComparePackageAcrossSystems,
} from '../../../handlers/multisystem/readonly/handleComparePackageAcrossSystems';
import {
  handleListSystems,
  TOOL_DEFINITION as ListSystems_Tool,
} from '../../../handlers/multisystem/readonly/handleListSystems';
import {
  TOOL_DEFINITION as GetPackageContents_Tool,
  handleGetPackageContents,
} from '../../../handlers/package/readonly/handleGetPackageContents';
import {
  handleReadPackage,
  TOOL_DEFINITION as ReadPackage_Tool,
} from '../../../handlers/package/readonly/handleReadPackage';
import {
  handleReadProgram,
  TOOL_DEFINITION as ReadProgram_Tool,
} from '../../../handlers/program/readonly/handleReadProgram';
import {
  handleReadServiceBinding,
  TOOL_DEFINITION as ReadServiceBinding_Tool,
} from '../../../handlers/service_binding/readonly/handleReadServiceBinding';
import {
  handleReadServiceDefinition,
  TOOL_DEFINITION as ReadServiceDefinition_Tool,
} from '../../../handlers/service_definition/readonly/handleReadServiceDefinition';
import {
  TOOL_DEFINITION as GetStructuresList_Tool,
  handleGetStructuresList,
} from '../../../handlers/structure/readonly/handleGetStructuresList';
import {
  handleReadStructure,
  TOOL_DEFINITION as ReadStructure_Tool,
} from '../../../handlers/structure/readonly/handleReadStructure';
import {
  TOOL_DEFINITION as GetTableContents_Tool,
  handleGetTableContents,
} from '../../../handlers/table/readonly/handleGetTableContents';
import {
  handleReadTable,
  TOOL_DEFINITION as ReadTable_Tool,
} from '../../../handlers/table/readonly/handleReadTable';
import {
  TOOL_DEFINITION as GetTransport_Tool,
  handleGetTransport,
} from '../../../handlers/transport/readonly/handleGetTransport';
import {
  handleListTransports,
  TOOL_DEFINITION as ListTransports_Tool,
} from '../../../handlers/transport/readonly/handleListTransports';
import {
  addOutputFileToSchema,
  shouldOfferOutputFile,
  withOutputToFile,
} from '../../fileTransfer.js';
import { BaseHandlerGroup } from '../base/BaseHandlerGroup.js';
import type { HandlerContext, HandlerEntry } from '../interfaces.js';
import {
  type IReadOnlyDedupStrategy,
  NoDedupStrategy,
} from './strategies/index.js';

/**
 * Handler group for all readonly (read-only) handlers.
 * Contains handlers that only read data without modifying the ABAP system.
 *
 * When other groups (HighLevel / LowLevel / Compact) are also exposed, some
 * readonly handlers semantically duplicate tools from those groups
 * (e.g. ReadFunctionModule vs GetFunctionModule). The group hides such
 * duplicates based on the injected override strategy and the set of tool
 * names contributed by the other groups.
 */
export class ReadOnlyHandlersGroup extends BaseHandlerGroup {
  protected groupName = 'ReadOnlyHandlers';
  private readonly overridingToolNames: ReadonlySet<string>;
  private readonly dedupStrategy: IReadOnlyDedupStrategy;

  constructor(
    context: HandlerContext,
    overridingToolNames: ReadonlySet<string> = new Set(),
    dedupStrategy: IReadOnlyDedupStrategy = new NoDedupStrategy(),
  ) {
    super(context);
    this.overridingToolNames = overridingToolNames;
    this.dedupStrategy = dedupStrategy;
  }

  /**
   * Gets all readonly handler entries, filtered by the dedup strategy.
   */
  getHandlers(): HandlerEntry[] {
    return this.getAllEntries().filter(
      (e) => !this.dedupStrategy.shouldExclude(e, this.overridingToolNames),
    );
  }

  private getAllEntries(): HandlerEntry[] {
    const entries: HandlerEntry[] = [
      // Existing readonly handlers
      {
        toolDefinition: GetTableContents_Tool,
        handler: (args: any) => handleGetTableContents(this.context, args),
      },
      {
        toolDefinition: GetPackageContents_Tool,
        handler: (args: any) => handleGetPackageContents(this.context, args),
      },
      {
        toolDefinition: GetInclude_Tool,
        handler: (args: any) => handleGetInclude(this.context, args),
      },
      {
        toolDefinition: AbapGitListRepos_Tool,
        handler: (args: any) => handleAbapGitListRepos(this.context, args),
      },
      // Cross-system comparison
      {
        toolDefinition: ListSystems_Tool,
        handler: (args: any) => handleListSystems(this.context, args),
      },
      {
        toolDefinition: CompareObjectAcrossSystems_Tool,
        handler: (args: any) =>
          handleCompareObjectAcrossSystems(this.context, args),
      },
      {
        toolDefinition: ComparePackageAcrossSystems_Tool,
        handler: (args: any) =>
          handleComparePackageAcrossSystems(this.context, args),
      },
      {
        toolDefinition: ComparePackageAcrossLandscape_Tool,
        handler: (args: any) =>
          handleComparePackageAcrossLandscape(this.context, args),
      },
      {
        toolDefinition: AbapGitGetRepo_Tool,
        handler: (args: any) => handleAbapGitGetRepo(this.context, args),
      },
      {
        toolDefinition: AbapGitGetErrorLog_Tool,
        handler: (args: any) => handleAbapGitGetErrorLog(this.context, args),
      },
      {
        toolDefinition: DebuggerGetStack_Tool,
        handler: (args: any) => handleDebuggerGetStack(this.context, args),
      },
      {
        toolDefinition: DebuggerListBreakpoints_Tool,
        handler: (args: any) =>
          handleDebuggerListBreakpoints(this.context, args),
      },
      {
        toolDefinition: DebuggerGetVariable_Tool,
        handler: (args: any) => handleDebuggerGetVariable(this.context, args),
      },
      {
        toolDefinition: GetIncludesList_Tool,
        handler: (args: any) => handleGetIncludesList(this.context, args),
      },
      {
        toolDefinition: GetEnhancements_Tool,
        handler: (args: any) => handleGetEnhancements(this.context, args),
      },
      {
        toolDefinition: GetEnhancementSpot_Tool,
        handler: (args: any) => handleGetEnhancementSpot(this.context, args),
      },
      {
        toolDefinition: GetEnhancementImpl_Tool,
        handler: (args: any) => handleGetEnhancementImpl(this.context, args),
      },
      {
        toolDefinition: GetTransport_Tool,
        handler: (args: any) => handleGetTransport(this.context, args),
      },
      {
        toolDefinition: ListTransports_Tool,
        handler: (args: any) => handleListTransports(this.context, args),
      },
      // Read object source + metadata handlers
      {
        toolDefinition: ReadClass_Tool,
        handler: (args: any) => handleReadClass(this.context, args),
      },
      {
        toolDefinition: ReadInterface_Tool,
        handler: (args: any) => handleReadInterface(this.context, args),
      },
      {
        toolDefinition: ReadProgram_Tool,
        handler: (args: any) => handleReadProgram(this.context, args),
      },
      {
        toolDefinition: ReadTable_Tool,
        handler: (args: any) => handleReadTable(this.context, args),
      },
      {
        toolDefinition: ReadStructure_Tool,
        handler: (args: any) => handleReadStructure(this.context, args),
      },
      {
        toolDefinition: GetStructuresList_Tool,
        handler: (args: any) => handleGetStructuresList(this.context, args),
      },
      {
        toolDefinition: GetObjectVersions_Tool,
        handler: (args: any) => handleGetObjectVersions(this.context, args),
      },
      {
        toolDefinition: GetObjectVersionSource_Tool,
        handler: (args: any) =>
          handleGetObjectVersionSource(this.context, args),
      },
      {
        toolDefinition: GetObjectVersionDiff_Tool,
        handler: (args: any) => handleGetObjectVersionDiff(this.context, args),
      },
      {
        toolDefinition: ReadDdl_Tool,
        handler: (args: any) => handleReadDdl(this.context, args),
      },
      {
        toolDefinition: ReadDomain_Tool,
        handler: (args: any) => handleReadDomain(this.context, args),
      },
      {
        toolDefinition: ReadMessageClass_Tool,
        handler: (args: any) => handleReadMessageClass(this.context, args),
      },
      {
        toolDefinition: ReadMessageClassMessage_Tool,
        handler: (args: any) =>
          handleReadMessageClassMessage(this.context, args),
      },
      {
        toolDefinition: ReadDataElement_Tool,
        handler: (args: any) => handleReadDataElement(this.context, args),
      },
      {
        toolDefinition: ReadFunctionModule_Tool,
        handler: (args: any) => handleReadFunctionModule(this.context, args),
      },
      {
        toolDefinition: ReadFunctionInclude_Tool,
        handler: (args: any) => handleReadFunctionInclude(this.context, args),
      },
      {
        toolDefinition: ListFunctionGroupIncludes_Tool,
        handler: (args: any) =>
          handleListFunctionGroupIncludes(this.context, args),
      },
      {
        toolDefinition: ListFunctionModules_Tool,
        handler: (args: any) => handleListFunctionModules(this.context, args),
      },
      {
        toolDefinition: ReadFunctionGroup_Tool,
        handler: (args: any) => handleReadFunctionGroup(this.context, args),
      },
      {
        toolDefinition: ReadPackage_Tool,
        handler: (args: any) => handleReadPackage(this.context, args),
      },
      {
        toolDefinition: ReadServiceDefinition_Tool,
        handler: (args: any) => handleReadServiceDefinition(this.context, args),
      },
      {
        toolDefinition: ReadMetadataExtension_Tool,
        handler: (args: any) => handleReadMetadataExtension(this.context, args),
      },
      {
        toolDefinition: ReadBehaviorDefinition_Tool,
        handler: (args: any) =>
          handleReadBehaviorDefinition(this.context, args),
      },
      {
        toolDefinition: ReadBehaviorImplementation_Tool,
        handler: (args: any) =>
          handleReadBehaviorImplementation(this.context, args),
      },
      {
        toolDefinition: ReadServiceBinding_Tool,
        handler: (args: any) => handleReadServiceBinding(this.context, args),
      },
    ];

    // Any read tool can divert its output to a local file. Opt-in per call:
    // without `to_file` nothing changes. This is what makes a 165 KB source or
    // a large result set usable without spending the context window on it.
    return entries.map((entry) =>
      shouldOfferOutputFile(entry.toolDefinition.name)
        ? {
            ...entry,
            toolDefinition: {
              ...entry.toolDefinition,
              inputSchema: addOutputFileToSchema(
                entry.toolDefinition.inputSchema,
              ),
            },
            handler: withOutputToFile(entry.handler),
          }
        : entry,
    );
  }
}

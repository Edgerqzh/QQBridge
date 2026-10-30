import {positiveId} from './context-actions.mjs';
import {createMutationRunner,requireAck,strictBoolean,boundedText} from './mutations.mjs';
const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});
const uid=value=>typeof value==='string'&&/^u_[A-Za-z0-9_-]{1,126}$/.test(value);
export const GROUP_MANAGEMENT_ACTIONS=Object.freeze(['get_group_info','set_group_ban','set_group_whole_ban','set_group_kick','set_group_admin','set_group_card','set_group_name','set_group_leave','transfer_group','dismiss_group']);

export function createGroupManagement({getContext,timeoutMs=8000}){
  const runner=createMutationRunner({timeoutMs});
  async function roster(c,group){
    const r=await c.services.groupService.getAllMemberList(group,true);c.check(group);
    if(r?.errCode!==0||r.result?.finish!==true||!(r.result.infos instanceof Map)||r.result.infos.size>10000)throw fail('A complete current group roster is required.');
    const users=new Map(),uids=new Set();
    for(const row of r.result.infos.values()){
      if(row?.isDelete===true)continue;
      const id=positiveId(row?.uin,'native user');
      if(!uid(row.uid)||![2,3,4].includes(row.role)||users.has(id)||uids.has(row.uid))throw fail('QQ returned an invalid group roster.');
      users.set(id,row);uids.add(row.uid);
    }
    const own=users.get(c.account.uin);if(!own||own.uid!==c.account.uid)throw fail('Current account is missing from the verified group roster.',1403);
    return {users,own};
  }
  return {
    status:runner.status,close:runner.close,
    async call(action,p){
      if(!GROUP_MANAGEMENT_ACTIONS.includes(action))throw fail('Unsupported group management action.',1404);
      const group=positiveId(p.group_id,'group_id'),c=getContext();c.check(group);
      // Parse every option before any native call, including an optional no-op.
      const user=['set_group_ban','set_group_kick','set_group_admin','set_group_card','transfer_group'].includes(action)?positiveId(p.user_id,'user_id'):null;
      const enable=['set_group_whole_ban','set_group_admin'].includes(action)?strictBoolean(p.enable,true,'enable'):null;
      const reject=strictBoolean(p.reject_add_request,false,'reject_add_request');
      const dismiss=action==='dismiss_group'||strictBoolean(p.is_dismiss,false,'is_dismiss');
      const transferToken=action==='transfer_group'?boundedText(p.token,'',4096,'token'):'';
      let duration=p.duration??1800;
      if(action==='set_group_ban'&&(!Number.isInteger(duration)||duration<0||duration>2592000))throw fail('duration must be an integer from 0 to 2592000 seconds.',1400);
      const card=action==='set_group_card'?boundedText(p.card,'',60,'card'):null;
      const name=action==='set_group_name'?boundedText(p.group_name,undefined,60,'group_name'):null;
      if(name!==null&&!name.trim())throw fail('group_name must not be empty.',1400);
      if(action==='get_group_info')strictBoolean(p.no_cache,false,'no_cache');
      return runner.run('group:'+group,async op=>{
        const {users,own}=await roster(c,group);op.check();c.check(group);
        const target=user?users.get(user):null;
        if(user&&!target)throw fail('Target is not a current group member.',1404);
        if(action==='get_group_info'){
          const g=c.groups().find(row=>String(row.groupCode)===group);if(!g)throw fail('Group snapshot is unavailable.');
          return {group_id:Number(group),group_name:g.groupName,member_count:users.size,max_member_count:g.maxMember};
        }
        if(action==='dismiss_group'||action==='set_group_leave'&&dismiss){
          if(own.role!==4)throw fail('Only the verified owner can dissolve a group.',1403);
        }else if(action==='transfer_group'){
          if(own.role!==4||user===c.account.uin||target.role===4)throw fail('Only the verified owner can transfer to another current member.',1403);
        }else if(action==='set_group_leave'){
          if(own.role===4)throw fail('The owner must transfer ownership before leaving.',1403);
        }else if(action==='set_group_admin'){
          if(own.role!==4||target.role===4||user===c.account.uin)throw fail('Only the owner can change another member administrator role.',1403);
        }else if(action==='set_group_card'&&user===c.account.uin){
          // Members may edit their own card. QQ still makes the final decision.
        }else{
          if(own.role<3)throw fail('The current account needs group administrator permission.',1403);
          if(target&&(target.role>=own.role||user===c.account.uin))throw fail('Target role is not below the current account role.',1403);
        }
        const s=c.services.groupService;
        const invoke=()=>{
          switch(action){
            case 'set_group_ban':return s.setMemberShutUp(group,[{uid:target.uid,timeStamp:duration}]);
            case 'set_group_whole_ban':return s.setGroupShutUp(group,enable);
            case 'set_group_kick':return s.kickMember(group,[target.uid],reject,'');
            case 'set_group_admin':return s.modifyMemberRole(group,target.uid,enable?3:2);
            case 'set_group_card':return s.modifyMemberCardName(group,target.uid,card);
            case 'set_group_name':return s.modifyGroupName(group,name,false);
            case 'set_group_leave':return dismiss?s.destroyGroup(group):s.quitGroup(group);
            case 'dismiss_group':return s.destroyGroup(group);
            case 'transfer_group':return s.transferGroup(group,target.uid,transferToken);
          }
        };
        c.check(group);const result=await op.invoke(invoke);requireAck(result);
        try{c.check(['set_group_leave','dismiss_group'].includes(action)?undefined:group);}catch{throw fail('QQ accepted the change but the account or group changed. Do not retry automatically.',1504);}
        return null;
      });
    },
  };
}
